/**
 * Envelope Store
 *
 * Append-only PostgreSQL store for AEE envelopes.
 * Provides SQL-queryable audit trail.
 *
 * QF-MT WP5: reads are org-scoped (mirrors workflow-store/execution-store —
 * see docs/STREAM_QUOXFLOW_MULTITENANCY_PLAN.md §4/§6). `get/query/count/
 * getCausalityChain/getByCorrelation` all take a mandatory `scope:
 * EnvelopeOrgScope` — only envelopes.ts and executions.ts call these, so the
 * blast radius of requiring it is fully contained.
 *
 * Writes (`append`/`appendBatch`) take an OPTIONAL orgId parameter that
 * defaults to SYSTEM_SCOPE. This deliberately deviates from the
 * workflow-store/execution-store "org is compile-required" pattern: dozens of
 * call sites across the skills/agentic/policy/approval subsystems emit
 * fire-and-forget audit envelopes outside WP5's scope. Every call site that
 * already has a real org in scope (control-pipeline.ts's per-run
 * ExecutionContext.orgId, quox-skills.ts/policies.ts/workflows.ts's resolved
 * scope, qskl-safety-aocl.ts's orgId param) has been threaded through
 * explicitly as part of this change. Sites that do not carry an org
 * (schedules.ts/approvals.ts/trigger-bootstrap.ts admin sweeps, proxy.ts's
 * internal n8n bridge — both already N/A per the plan) fall to the same
 * SYSTEM_SCOPE default, i.e. unchanged pre-WP5 behavior (hidden from tenant
 * reads, never leaked).
 */

import pg from 'pg';
import { Envelope, EnvelopeType, Priority, Intents } from '../core/envelope.js';
import type { EnvelopeSink } from './envelope-forwarder.js';
import { SYSTEM_SCOPE, SystemScope } from '../api/middleware/org-scope.js';

const { Pool } = pg;

/** Org scope accepted by every read method — string org id, or the explicit
 * cross-org SYSTEM_SCOPE sentinel (never an absent parameter). */
export type EnvelopeOrgScope = string | SystemScope;

/** Sentinel org_id value legacy/system-authored rows fall to — mirrors the
 * Postgres column's `DEFAULT 'default'` (plan §5). */
const LEGACY_ORG_ID = 'default';

/**
 * QUOXTRUST-B2: max forward attempts before a row is retired to
 * forward_status='failed' — without a cap, a permanently-unreachable
 * collector (bad URL, revoked key) would retry the same row forever.
 * Retired rows are surfaced via getForwardStats().failed for observability
 * rather than retried again.
 */
const FORWARD_ATTEMPT_CAP = 10;

/** Per-envelope forward outbox state (mirrors the forward_status/
 * forward_attempts/forwarded_at/last_forward_error columns).
 *
 * QUOXTRUST-B2f: 'pre_outbox' is a terminal status stamped onto rows that
 * existed before the forward_* columns were added to a live table (see the
 * ALTER migration in init()). Their true forward state predates the outbox
 * and is unknowable, so the drain must never attempt them and they must
 * never be reported as 'forwarded'. */
export interface ForwardMeta {
  status: 'pending' | 'forwarded' | 'failed' | 'pre_outbox';
  attempts: number;
  forwardedAt?: string;
  lastError?: string;
}

/** Aggregate outbox counts, for observability (dashboards/health checks).
 * pre_outbox counts pre-existing rows backfilled by the ALTER migration
 * (QUOXTRUST-B2f) whose true forward state is unknown and permanently
 * excluded from the drain. */
export interface ForwardStats {
  pending: number;
  forwarded: number;
  failed: number;
  pre_outbox: number;
}

/** Result of a single drainPendingForwards() call. */
export interface DrainResult {
  /** Rows picked up this drain (0 means nothing was pending — NOT a failure). */
  attempted: number;
  /** Rows successfully forwarded and marked 'forwarded' this drain. */
  forwarded: number;
  /** Rows whose forward attempt failed this drain (still 'pending', or
   * retired to 'failed' if they just hit FORWARD_ATTEMPT_CAP). */
  failed: number;
}

/**
 * QUOXTRUST-B3: one row returned by findUnsettledDispatchIntents(), the
 * dispatch-intent envelope itself, plus the org it was written under (the
 * wire-protocol Envelope never carries org_id, see orgByEnvelopeId above,
 * so the store threads it back out here for the reconciliation pass to
 * write the outcome_unknown envelope into the SAME org).
 */
export interface DispatchIntentRecord {
  envelope: Envelope;
  orgId: string;
}

/** Resolve the org_id value to persist for a write. Absent/SYSTEM_SCOPE
 * writes are stamped with the legacy sentinel — visible to SYSTEM_SCOPE
 * reads only (see module docstring for why writes default rather than
 * require). */
function resolveWriteOrgId(scope: EnvelopeOrgScope): string {
  return scope === SYSTEM_SCOPE ? LEGACY_ORG_ID : scope;
}

/** True when a stored row's org matches the caller's scope. SYSTEM_SCOPE
 * matches everything (explicit cross-org). Tenant scopes never match legacy/
 * undefined rows — unbackfilled rows are hidden, not leaked. */
function orgMatches(rowOrgId: string | undefined, scope: EnvelopeOrgScope): boolean {
  if (scope === SYSTEM_SCOPE) return true;
  if (rowOrgId === undefined || rowOrgId === LEGACY_ORG_ID) return false;
  return rowOrgId === scope;
}

export interface EnvelopeStoreConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface QueryOptions {
  corr?: string;           // Filter by correlation ID
  intent?: string;         // Filter by intent (supports LIKE patterns)
  type?: EnvelopeType;     // Filter by envelope type
  from?: string;           // Filter by sender
  to?: string;             // Filter by recipient
  since?: Date;            // Filter by timestamp
  until?: Date;
  limit?: number;
  offset?: number;
}

/**
 * PostgreSQL-backed envelope store
 */
export class EnvelopeStore {
  private pool: pg.Pool | null = null;
  private inMemory: Map<string, Envelope> = new Map();
  /** QF-MT WP5: in-memory org tracking — the wire-protocol Envelope type
   * deliberately does NOT carry org_id (it would leak into cross-service AEE
   * payloads), so org is tracked out-of-band here, mirroring the org_id
   * column that exists only in the Postgres table. */
  private orgByEnvelopeId: Map<string, string> = new Map();
  private useInMemory: boolean;
  private sink: EnvelopeSink | null = null;
  /** QUOXTRUST-B2: durable outbox state for the in-memory path — mirrors the
   * forward_status/forward_attempts/forwarded_at/last_forward_error columns
   * added to the Postgres `envelopes` table. Insertion order (Map preserves
   * it) doubles as "oldest first" for drainPendingForwards(). */
  private forwardMeta: Map<string, ForwardMeta> = new Map();
  /** Consecutive drainPendingForwards() calls that attempted >=1 row and
   * forwarded none — the scheduler's backoff signal. An empty drain (nothing
   * pending) does not touch this; any successful forward resets it to 0. */
  private consecutiveFailedDrains = 0;

  /**
   * Attach an out-of-band sink that receives every successfully-persisted
   * envelope. Used to forward to the collector's /aee/sync endpoint so
   * workflow envelopes show up in the dashboard ActivityView. Sink errors
   * MUST NOT propagate — call it fire-and-forget.
   */
  setSink(sink: EnvelopeSink | null): void {
    this.sink = sink;
  }

  constructor(config?: EnvelopeStoreConfig) {
    this.useInMemory = !config;
    if (config) {
      this.pool = new Pool(config);
    }
  }

  /**
   * Initialize the store (create table if needed)
   */
  async init(): Promise<void> {
    if (this.useInMemory) return;

    const createTable = `
      CREATE TABLE IF NOT EXISTS envelopes (
        id VARCHAR(26) PRIMARY KEY,
        v VARCHAR(10) DEFAULT '1',
        org_id VARCHAR(255) NOT NULL DEFAULT 'default',
        from_addr VARCHAR(255) NOT NULL,
        to_addr VARCHAR(255) NOT NULL,
        type VARCHAR(20) NOT NULL,
        intent VARCHAR(255) NOT NULL,
        corr VARCHAR(255) NOT NULL,
        reply_to VARCHAR(26),
        ts TIMESTAMPTZ NOT NULL,
        priority VARCHAR(20),
        requires JSONB,
        payload JSONB NOT NULL,
        evidence_refs JSONB,
        trace JSONB,
        sig TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        forward_status TEXT NOT NULL DEFAULT 'pending',
        forward_attempts INTEGER NOT NULL DEFAULT 0,
        forwarded_at TIMESTAMPTZ,
        last_forward_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_envelopes_org_id ON envelopes(org_id);
      CREATE INDEX IF NOT EXISTS idx_envelopes_corr ON envelopes(corr);
      CREATE INDEX IF NOT EXISTS idx_envelopes_reply_to ON envelopes(reply_to);
      CREATE INDEX IF NOT EXISTS idx_envelopes_intent ON envelopes(intent);
      CREATE INDEX IF NOT EXISTS idx_envelopes_ts ON envelopes(ts);
      CREATE INDEX IF NOT EXISTS idx_envelopes_type ON envelopes(type);
    `;

    await this.pool!.query(createTable);

    // QUOXTRUST-B2f: durable forward outbox columns, guarded so the ADD +
    // backfill only ever runs once, the first time forward_status is missing.
    // A plain `ADD COLUMN IF NOT EXISTS ... DEFAULT 'pending'` (the original
    // B2 shape) stamps every PRE-EXISTING row 'pending' the moment this runs
    // against a live table that already has data — a live-PG smoke test
    // found this would have re-forwarded 2,548,093 historical envelopes to
    // the collector on the dev DB. Those rows predate the outbox: their true
    // forward state is unknown, so they are backfilled to the terminal
    // 'pre_outbox' status instead (never 'pending', never falsely
    // 'forwarded') in the SAME transactional block as the ALTER, so no row
    // is ever observable in the wrong state. A CREATE-TABLE-fresh table has
    // no pre-existing rows, so its DEFAULT 'pending' above is correct as-is
    // and this block is a no-op for it (forward_status already exists).
    await this.pool!.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'envelopes' AND column_name = 'forward_status'
        ) THEN
          ALTER TABLE envelopes ADD COLUMN forward_status TEXT NOT NULL DEFAULT 'pending';
          ALTER TABLE envelopes ADD COLUMN forward_attempts INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE envelopes ADD COLUMN forwarded_at TIMESTAMPTZ;
          ALTER TABLE envelopes ADD COLUMN last_forward_error TEXT;
          UPDATE envelopes SET forward_status = 'pre_outbox', forwarded_at = NULL;
        END IF;
      END $$;
    `);
    await this.pool!.query(`
      CREATE INDEX IF NOT EXISTS idx_envelopes_forward_status ON envelopes(forward_status);
    `);
  }

  /**
   * Append an envelope (immutable - no updates allowed).
   * Idempotent: duplicate ULID (PK-conflict) is silently swallowed — same
   * envelope was already persisted by a prior streaming call.
   *
   * QF-MT WP5: `orgId` defaults to SYSTEM_SCOPE — see the module docstring
   * for why writes default rather than require (unlike execution-store /
   * workflow-store). Callers on the tenant-execution write path (the
   * control-pipeline per-run context, quox-skills/policies/workflows routes)
   * pass the real resolved org explicitly.
   */
  async append(envelope: Envelope, orgId: EnvelopeOrgScope = SYSTEM_SCOPE): Promise<void> {
    if (this.useInMemory) {
      if (this.inMemory.has(envelope.id)) return;  // idempotent
      this.inMemory.set(envelope.id, envelope);
      this.orgByEnvelopeId.set(envelope.id, resolveWriteOrgId(orgId));
      this.forwardMeta.set(envelope.id, { status: 'pending', attempts: 0 });
      this.notifySink([envelope], resolveWriteOrgId(orgId));
      return;
    }

    const query = `
      INSERT INTO envelopes (
        id, v, org_id, from_addr, to_addr, type, intent, corr, reply_to,
        ts, priority, requires, payload, evidence_refs, trace, sig
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    `;

    try {
      await this.pool!.query(query, [
        envelope.id,
        envelope.v,
        resolveWriteOrgId(orgId),
        envelope.from,
        envelope.to,
        envelope.type,
        envelope.intent,
        envelope.corr,
        envelope.reply_to,
        envelope.ts,
        envelope.priority ?? null,
        envelope.requires ? JSON.stringify(envelope.requires) : null,
        JSON.stringify(envelope.payload),
        envelope.evidence_refs ? JSON.stringify(envelope.evidence_refs) : null,
        envelope.trace ? JSON.stringify(envelope.trace) : null,
        envelope.sig ?? null,
      ]);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        // Duplicate ULID — same envelope was already streamed. Idempotent no-op.
        return;
      }
      throw err;
    }
    this.notifySink([envelope], resolveWriteOrgId(orgId));
  }

  private notifySink(envelopes: Envelope[], resolvedOrgId?: string): void {
    if (!this.sink || envelopes.length === 0) return;
    // AEE-ORG-BACKFILL P1: this store persists the write's org in its own
    // org_id column, but forwarded bare envelopes — so the collector's
    // deriveEnvelopeOrgId found nothing and stored them untagged into the
    // NULL bucket its /aee/query serves to every tenant. Stamp copies (never
    // the caller-owned objects) with the resolved org so the collector's
    // priority-1 source (envelope.org_id) picks it up. The legacy system
    // sentinel is deliberately not stamped: 'default' matches no tenant on
    // the collector either, and NULL is the honest value for platform writes.
    const forwarded = resolvedOrgId && resolvedOrgId !== LEGACY_ORG_ID
      ? envelopes.map(env => ({ ...env, org_id: resolvedOrgId }))
      : envelopes;
    // QUOXTRUST-B2: this call stays fire-and-forget (append/appendBatch do
    // not await it — persistence in this store is already done by the time
    // notifySink runs), but the outcome is no longer discarded. A failed
    // forward leaves the row 'pending' in the durable outbox for
    // drainPendingForwards() to retry, instead of being dropped forever.
    const ids = envelopes.map(env => env.id);
    void this.invokeSink(this.sink, forwarded).then(success =>
      this.recordForwardResult(ids, success, success ? undefined : 'live forward failed').catch(() => {})
    );
  }

  /**
   * Calls a sink and normalizes its (possibly void/boolean/Promise<boolean>)
   * result to a Promise<boolean> that never rejects. A `void`-returning sink
   * (legacy callers, most existing tests) is treated as an untrackable
   * fire-and-forget call and reported as success — its outcome simply can't
   * be observed, which matches pre-QUOXTRUST-B2 behavior for those callers.
   */
  private invokeSink(sink: EnvelopeSink, envelopes: Envelope[]): Promise<boolean> {
    try {
      const result = sink(envelopes);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<boolean | void>)
          .then(value => value !== false)
          .catch(err => {
            console.warn('[EnvelopeStore] sink promise rejected (suppressed):', err instanceof Error ? err.message : err);
            return false;
          });
      }
      if (typeof result === 'boolean') return Promise.resolve(result);
      return Promise.resolve(true);
    } catch (err) {
      console.warn('[EnvelopeStore] sink threw (suppressed):', err instanceof Error ? err.message : err);
      return Promise.resolve(false);
    }
  }

  /**
   * Record the outcome of a forward attempt against the durable outbox.
   * Success marks the rows 'forwarded'. Failure increments forward_attempts
   * and retires the row to 'failed' once FORWARD_ATTEMPT_CAP is hit —
   * otherwise it stays 'pending' for the next drainPendingForwards() call.
   */
  private async recordForwardResult(ids: string[], success: boolean, error?: string): Promise<void> {
    if (ids.length === 0) return;

    if (this.useInMemory) {
      for (const id of ids) {
        const meta = this.forwardMeta.get(id);
        if (!meta) continue;
        if (success) {
          meta.status = 'forwarded';
          meta.forwardedAt = new Date().toISOString();
          meta.lastError = undefined;
        } else {
          meta.attempts += 1;
          meta.lastError = error;
          meta.status = meta.attempts >= FORWARD_ATTEMPT_CAP ? 'failed' : 'pending';
        }
      }
      return;
    }

    if (success) {
      await this.pool!.query(
        `UPDATE envelopes
         SET forward_status = 'forwarded', forwarded_at = NOW(), last_forward_error = NULL
         WHERE id = ANY($1)`,
        [ids]
      );
    } else {
      await this.pool!.query(
        `UPDATE envelopes
         SET forward_attempts = forward_attempts + 1,
             last_forward_error = $2,
             forward_status = CASE WHEN forward_attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END
         WHERE id = ANY($1)`,
        [ids, error ?? null, FORWARD_ATTEMPT_CAP]
      );
    }
  }

  /**
   * Retry pending forwards. Picks up to `limit` oldest 'pending' rows and
   * re-POSTs them via the same attached sink, in one batch. Implements the
   * scheduler triad (see class docstring on consecutiveFailedDrains):
   *   (a) a drain that attempted 0 rows is NOT a failure — it just means
   *       nothing was pending — and never touches the backoff counter;
   *   (b) consecutive drains that attempted >=1 row and forwarded none bump
   *       consecutiveFailedDrains for the caller's backoff; any progress
   *       resets it to 0;
   *   (c) recordForwardResult() retires a row to 'failed' once it hits
   *       FORWARD_ATTEMPT_CAP, so it stops being returned here.
   */
  async drainPendingForwards(limit = 50): Promise<DrainResult> {
    if (!this.sink) return { attempted: 0, forwarded: 0, failed: 0 };

    if (this.useInMemory) {
      const pendingIds: string[] = [];
      for (const [id, meta] of this.forwardMeta) {
        if (meta.status !== 'pending') continue;
        pendingIds.push(id);
        if (pendingIds.length >= limit) break;
      }

      if (pendingIds.length === 0) {
        // (a) empty drain — not a failure, backoff counter untouched.
        return { attempted: 0, forwarded: 0, failed: 0 };
      }

      const envelopes = pendingIds
        .map(id => this.inMemory.get(id))
        .filter((e): e is Envelope => Boolean(e));
      const forwarded = envelopes.map(env => {
        const orgId = this.orgByEnvelopeId.get(env.id);
        return orgId && orgId !== LEGACY_ORG_ID ? { ...env, org_id: orgId } : env;
      });

      const success = await this.invokeSink(this.sink, forwarded);
      await this.recordForwardResult(pendingIds, success, success ? undefined : 'drain forward failed');
      this.consecutiveFailedDrains = success ? 0 : this.consecutiveFailedDrains + 1;

      return {
        attempted: pendingIds.length,
        forwarded: success ? pendingIds.length : 0,
        failed: success ? 0 : pendingIds.length,
      };
    }

    const result = await this.pool!.query(
      'SELECT * FROM envelopes WHERE forward_status = $1 ORDER BY ts ASC, id ASC LIMIT $2',
      ['pending', limit]
    );

    if (result.rows.length === 0) {
      // (a) empty drain — not a failure, backoff counter untouched.
      return { attempted: 0, forwarded: 0, failed: 0 };
    }

    const ids = result.rows.map(row => row.id as string);
    const forwarded = result.rows.map(row => {
      const envelope = this.rowToEnvelope(row);
      const orgId = row.org_id as string | undefined;
      return orgId && orgId !== LEGACY_ORG_ID ? { ...envelope, org_id: orgId } : envelope;
    });

    const success = await this.invokeSink(this.sink, forwarded);
    await this.recordForwardResult(ids, success, success ? undefined : 'drain forward failed');
    this.consecutiveFailedDrains = success ? 0 : this.consecutiveFailedDrains + 1;

    return {
      attempted: ids.length,
      forwarded: success ? ids.length : 0,
      failed: success ? 0 : ids.length,
    };
  }

  /** Consecutive drains that attempted >=1 row and forwarded none — the
   * signal the periodic drain scheduler in server.ts uses for backoff. */
  getConsecutiveFailedDrains(): number {
    return this.consecutiveFailedDrains;
  }

  /** Aggregate outbox counts for observability. */
  async getForwardStats(): Promise<ForwardStats> {
    if (this.useInMemory) {
      const stats: ForwardStats = { pending: 0, forwarded: 0, failed: 0, pre_outbox: 0 };
      for (const meta of this.forwardMeta.values()) {
        stats[meta.status] += 1;
      }
      return stats;
    }

    const result = await this.pool!.query(
      "SELECT forward_status, COUNT(*)::int AS count FROM envelopes GROUP BY forward_status"
    );
    const stats: ForwardStats = { pending: 0, forwarded: 0, failed: 0, pre_outbox: 0 };
    for (const row of result.rows) {
      const status = row.forward_status as 'pending' | 'forwarded' | 'failed' | 'pre_outbox';
      if (status === 'pending' || status === 'forwarded' || status === 'failed' || status === 'pre_outbox') {
        stats[status] = row.count as number;
      }
    }
    return stats;
  }

  /** Per-envelope forward outbox state (observability / tests). Null if the
   * envelope doesn't exist. */
  async getForwardMeta(id: string): Promise<ForwardMeta | null> {
    if (this.useInMemory) {
      const meta = this.forwardMeta.get(id);
      return meta ? { ...meta } : null;
    }

    const result = await this.pool!.query(
      'SELECT forward_status, forward_attempts, forwarded_at, last_forward_error FROM envelopes WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      status: row.forward_status as ForwardMeta['status'],
      attempts: row.forward_attempts as number,
      forwardedAt: row.forwarded_at ? (row.forwarded_at as Date).toISOString() : undefined,
      lastError: row.last_forward_error ?? undefined,
    };
  }

  /**
   * Append multiple envelopes in a transaction. QF-MT WP5: `orgId` defaults
   * to SYSTEM_SCOPE — see append()'s docstring.
   */
  async appendBatch(envelopes: Envelope[], orgId: EnvelopeOrgScope = SYSTEM_SCOPE): Promise<void> {
    if (this.useInMemory) {
      const resolvedOrgId = resolveWriteOrgId(orgId);
      for (const env of envelopes) {
        this.inMemory.set(env.id, env);
        this.orgByEnvelopeId.set(env.id, resolvedOrgId);
        this.forwardMeta.set(env.id, { status: 'pending', attempts: 0 });
      }
      this.notifySink(envelopes, resolvedOrgId);
      return;
    }

    const resolvedOrgId = resolveWriteOrgId(orgId);
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');

      for (const envelope of envelopes) {
        await client.query(
          `INSERT INTO envelopes (
            id, v, org_id, from_addr, to_addr, type, intent, corr, reply_to,
            ts, priority, requires, payload, evidence_refs, trace, sig
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
          ON CONFLICT (id) DO NOTHING`,
          [
            envelope.id,
            envelope.v,
            resolvedOrgId,
            envelope.from,
            envelope.to,
            envelope.type,
            envelope.intent,
            envelope.corr,
            envelope.reply_to,
            envelope.ts,
            envelope.priority ?? null,
            envelope.requires ? JSON.stringify(envelope.requires) : null,
            JSON.stringify(envelope.payload),
            envelope.evidence_refs ? JSON.stringify(envelope.evidence_refs) : null,
            envelope.trace ? JSON.stringify(envelope.trace) : null,
            envelope.sig ?? null,
          ]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    this.notifySink(envelopes, resolvedOrgId);
  }

  /**
   * Get envelope by ID. QF-MT WP5: org-scoped — cross-org id returns null
   * (routes turn that into 404, never a thrown 403).
   */
  async get(id: string, scope: EnvelopeOrgScope): Promise<Envelope | null> {
    if (this.useInMemory) {
      const envelope = this.inMemory.get(id);
      if (!envelope) return null;
      if (!orgMatches(this.orgByEnvelopeId.get(id), scope)) return null;
      return envelope;
    }

    const params: unknown[] = [id];
    let query = 'SELECT * FROM envelopes WHERE id = $1';
    if (scope !== SYSTEM_SCOPE) {
      query += ' AND org_id = $2';
      params.push(scope);
    }

    const result = await this.pool!.query(query, params);

    return result.rows[0] ? this.rowToEnvelope(result.rows[0]) : null;
  }

  /**
   * Query envelopes with filters. QF-MT WP5: org-scoped.
   */
  async query(options: QueryOptions, scope: EnvelopeOrgScope): Promise<Envelope[]> {
    if (this.useInMemory) {
      return this.queryInMemory(options, scope);
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (scope !== SYSTEM_SCOPE) {
      conditions.push(`org_id = $${paramIndex++}`);
      params.push(scope);
    }

    if (options.corr) {
      conditions.push(`corr = $${paramIndex++}`);
      params.push(options.corr);
    }

    if (options.intent) {
      if (options.intent.includes('%')) {
        conditions.push(`intent LIKE $${paramIndex++}`);
      } else {
        conditions.push(`intent = $${paramIndex++}`);
      }
      params.push(options.intent);
    }

    if (options.type) {
      conditions.push(`type = $${paramIndex++}`);
      params.push(options.type);
    }

    if (options.from) {
      conditions.push(`from_addr = $${paramIndex++}`);
      params.push(options.from);
    }

    if (options.to) {
      conditions.push(`to_addr = $${paramIndex++}`);
      params.push(options.to);
    }

    if (options.since) {
      conditions.push(`ts >= $${paramIndex++}`);
      params.push(options.since.toISOString());
    }

    if (options.until) {
      conditions.push(`ts <= $${paramIndex++}`);
      params.push(options.until.toISOString());
    }

    let query = 'SELECT * FROM envelopes';
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY ts ASC';

    if (options.limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options.offset) {
      query += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const result = await this.pool!.query(query, params);
    return result.rows.map(row => this.rowToEnvelope(row));
  }

  /**
   * Get causality chain (all envelopes linked by reply_to).
   *
   * QF-MT WP5 semantics: the caller (envelopes.ts) already verifies the
   * START envelope belongs to the caller's org via get(id, scope) before
   * calling this — a cross-org start id never reaches here (404 already
   * fired). Within the chain, any element that turns out to belong to a
   * different org (reply_to graphs should never legitimately cross tenants,
   * but this is defense-in-depth against a corrupted/spoofed reply_to) is
   * OMITTED from the traversal rather than 404ing the whole request —
   * chosen because the request already resolved to a real, owned envelope;
   * silently pruning foreign nodes matches the "hide existence" rule without
   * discarding the caller's otherwise-valid causality trail.
   */
  async getCausalityChain(startId: string, scope: EnvelopeOrgScope): Promise<Envelope[]> {
    if (this.useInMemory) {
      return this.getCausalityChainInMemory(startId, scope);
    }

    // Recursive CTE to follow the reply_to chain. The org filter (when
    // scoped) is applied inside BOTH the base case and the recursive term,
    // so traversal simply never crosses into a foreign-org row.
    const params: unknown[] = [startId];
    const orgFilter = scope !== SYSTEM_SCOPE ? ' AND org_id = $2' : '';
    if (scope !== SYSTEM_SCOPE) params.push(scope);

    const query = `
      WITH RECURSIVE chain AS (
        SELECT * FROM envelopes WHERE id = $1${orgFilter}
        UNION ALL
        SELECT e.* FROM envelopes e
        INNER JOIN chain c ON e.reply_to = c.id
        WHERE 1=1${orgFilter}
      )
      SELECT * FROM chain ORDER BY ts ASC
    `;

    const result = await this.pool!.query(query, params);
    return result.rows.map(row => this.rowToEnvelope(row));
  }

  /**
   * Get all envelopes for a correlation ID, ordered by time. QF-MT WP5: org-scoped.
   */
  async getByCorrelation(corr: string, scope: EnvelopeOrgScope): Promise<Envelope[]> {
    return this.query({ corr }, scope);
  }

  /**
   * Count envelopes matching query. QF-MT WP5: org-scoped.
   */
  async count(options: Omit<QueryOptions, 'limit' | 'offset'>, scope: EnvelopeOrgScope): Promise<number> {
    if (this.useInMemory) {
      return this.queryInMemory(options, scope).length;
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (scope !== SYSTEM_SCOPE) {
      conditions.push(`org_id = $${paramIndex++}`);
      params.push(scope);
    }

    if (options.corr) {
      conditions.push(`corr = $${paramIndex++}`);
      params.push(options.corr);
    }

    if (options.intent) {
      conditions.push(`intent LIKE $${paramIndex++}`);
      params.push(options.intent);
    }

    if (options.type) {
      conditions.push(`type = $${paramIndex++}`);
      params.push(options.type);
    }

    let query = 'SELECT COUNT(*) FROM envelopes';
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    const result = await this.pool!.query(query, params);
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Close the connection pool
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  /**
   * Convert database row to Envelope
   */
  private rowToEnvelope(row: Record<string, unknown>): Envelope {
    return {
      v: '1',
      id: row.id as string,
      from: row.from_addr as string,
      to: row.to_addr as string,
      type: row.type as EnvelopeType,
      intent: row.intent as string,
      corr: row.corr as string,
      reply_to: row.reply_to as string | null,
      ts: (row.ts as Date).toISOString(),
      priority: row.priority as Priority | undefined,
      requires: row.requires as Envelope['requires'],
      payload: row.payload,
      evidence_refs: row.evidence_refs as string[] | undefined,
      trace: row.trace as Envelope['trace'],
      sig: row.sig as string | undefined,
    };
  }

  /**
   * In-memory query implementation
   */
  private queryInMemory(options: QueryOptions, scope: EnvelopeOrgScope): Envelope[] {
    let results = Array.from(this.inMemory.values())
      .filter(e => orgMatches(this.orgByEnvelopeId.get(e.id), scope));

    if (options.corr) {
      results = results.filter(e => e.corr === options.corr);
    }

    if (options.intent) {
      if (options.intent.includes('%')) {
        const pattern = new RegExp(options.intent.replace(/%/g, '.*'));
        results = results.filter(e => pattern.test(e.intent));
      } else {
        results = results.filter(e => e.intent === options.intent);
      }
    }

    if (options.type) {
      results = results.filter(e => e.type === options.type);
    }

    if (options.from) {
      results = results.filter(e => e.from === options.from);
    }

    if (options.to) {
      results = results.filter(e => e.to === options.to);
    }

    if (options.since) {
      results = results.filter(e => new Date(e.ts) >= options.since!);
    }

    if (options.until) {
      results = results.filter(e => new Date(e.ts) <= options.until!);
    }

    // Sort by timestamp
    results.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    if (options.offset) {
      results = results.slice(options.offset);
    }

    if (options.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /**
   * In-memory causality chain traversal. QF-MT WP5: mirrors the Postgres
   * recursive CTE's semantics — a foreign-org node halts traversal in that
   * direction (omitted, not just skipped-but-still-walked-through) rather
   * than 404ing the whole request. See getCausalityChain()'s docstring.
   */
  private getCausalityChainInMemory(startId: string, scope: EnvelopeOrgScope): Envelope[] {
    const owned = (id: string): boolean => orgMatches(this.orgByEnvelopeId.get(id), scope);

    const chain: Envelope[] = [];
    const visited = new Set<string>();

    // Walk backwards to find root
    let current = owned(startId) ? this.inMemory.get(startId) : undefined;
    const ancestors: Envelope[] = [];

    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      ancestors.unshift(current);
      if (current.reply_to && owned(current.reply_to)) {
        current = this.inMemory.get(current.reply_to);
      } else {
        break;
      }
    }

    chain.push(...ancestors);

    // Walk forward to find descendants
    const queue = [startId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const env of this.inMemory.values()) {
        if (env.reply_to === id && !visited.has(env.id) && owned(env.id)) {
          visited.add(env.id);
          chain.push(env);
          queue.push(env.id);
        }
      }
    }

    // Sort by timestamp
    chain.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    return chain;
  }

  /**
   * Get all envelopes (for testing/debugging)
   */
  async getAll(): Promise<Envelope[]> {
    if (this.useInMemory) {
      return Array.from(this.inMemory.values())
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    }

    const result = await this.pool!.query('SELECT * FROM envelopes ORDER BY ts ASC');
    return result.rows.map(row => this.rowToEnvelope(row));
  }

  /**
   * QUOXTRUST-B3: crash-recovery query for control-pipeline.ts's
   * dispatchExecutor(). Finds every `quox.flow.dispatch.intent` envelope
   * older than `olderThanMs` that has NO correlated `quox.flow.dispatch.
   * settled` or `quox.flow.dispatch.outcome_unknown` envelope, meaning the
   * process died between recording the intent and recording the outcome.
   *
   * Correlation is via `payload.corr`, which the settled/outcome_unknown
   * envelopes set to the intent envelope's own `id` (NOT the AEE-level
   * `corr` field, which is shared by every envelope in the whole workflow
   * run and would not distinguish between nodes or retries of the same
   * node).
   *
   * Idempotent by construction: once an outcome_unknown has been appended
   * for an intent, that intent's id shows up as a matched `payload.corr` on
   * a subsequent call and is excluded.
   */
  async findUnsettledDispatchIntents(olderThanMs: number): Promise<DispatchIntentRecord[]> {
    const thresholdMs = Date.now() - olderThanMs;

    if (this.useInMemory) {
      const settledCorrIds = new Set<string>();
      for (const env of this.inMemory.values()) {
        if (env.intent !== Intents.DISPATCH.SETTLED && env.intent !== Intents.DISPATCH.OUTCOME_UNKNOWN) continue;
        const corr = (env.payload as { corr?: unknown } | undefined)?.corr;
        if (typeof corr === 'string') settledCorrIds.add(corr);
      }

      const results: DispatchIntentRecord[] = [];
      for (const env of this.inMemory.values()) {
        if (env.intent !== Intents.DISPATCH.INTENT) continue;
        if (new Date(env.ts).getTime() > thresholdMs) continue;
        if (settledCorrIds.has(env.id)) continue;
        results.push({ envelope: env, orgId: this.orgByEnvelopeId.get(env.id) ?? LEGACY_ORG_ID });
      }
      results.sort((a, b) => new Date(a.envelope.ts).getTime() - new Date(b.envelope.ts).getTime());
      return results;
    }

    const result = await this.pool!.query(
      `SELECT * FROM envelopes e
       WHERE e.intent = $1 AND e.ts < $2
       AND NOT EXISTS (
         SELECT 1 FROM envelopes s
         WHERE s.intent IN ($3, $4)
         AND s.payload->>'corr' = e.id
       )
       ORDER BY e.ts ASC`,
      [
        Intents.DISPATCH.INTENT,
        new Date(thresholdMs).toISOString(),
        Intents.DISPATCH.SETTLED,
        Intents.DISPATCH.OUTCOME_UNKNOWN,
      ]
    );

    return result.rows.map(row => ({
      envelope: this.rowToEnvelope(row),
      orgId: (row.org_id as string | undefined) ?? LEGACY_ORG_ID,
    }));
  }
}

/**
 * Create an in-memory store (for testing or single-run CLI usage)
 */
export function createInMemoryStore(): EnvelopeStore {
  return new EnvelopeStore();
}

/**
 * Create a PostgreSQL-backed store
 */
export function createPostgresStore(config: EnvelopeStoreConfig): EnvelopeStore {
  return new EnvelopeStore(config);
}
