/**
 * Replay-Only Flags Store — REPLAY-ONLY .A-1a
 *
 * Minimal flag store backing the `replay_only` compliance toggle described in
 * docs/STREAM_REPLAY_ONLY_MODE_PLAN.md §3.1 and refined by
 * docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md §6 Q2: this is deliberately a flat,
 * scope-keyed flag store — NOT the org→scope→agent→workflow→run cascade
 * config table the original plan sketched. PROF-1's resolver will expose the
 * real toggle *surface* later; this store + resolveEffectiveReplayOnly() is
 * the "minimal internal flag-resolution function" the review recommended
 * building the *enforcement* against in the meantime (§6 Q2, confidence
 * med-high). Don't build a competing cascade system here.
 *
 * Claim scope is PER-RUN (§6 Q1): resolveEffectiveReplayOnly() answers "is
 * this run replay-only", not "is the whole org in a replay-only window".
 *
 * Supports both PostgreSQL and in-memory storage, following the dual-mode
 * pattern used by policy-store.ts / budget-store.ts.
 *
 * SCOPE NOTE: this module is foundation only (store + resolver). No
 * denial/abort/gate logic lives here — that's REPLAY-ONLY .A-1b.
 */

import pg from 'pg';

const { Pool } = pg;

export type ReplayOnlyScopeType = 'org' | 'workflow' | 'agent' | 'run';

export interface ReplayOnlyFlagsStore {
  /** Set (upsert) the replay_only flag for a scope. */
  setFlag(scopeType: ReplayOnlyScopeType, scopeId: string, replayOnly: boolean): Promise<void>;
  /** Get the replay_only flag for a scope. A missing row resolves to false. */
  getFlag(scopeType: ReplayOnlyScopeType, scopeId: string): Promise<boolean>;
  close?(): Promise<void>;
}

// ─── In-Memory Implementation ──────────────────────────────────────────────

export class InMemoryReplayOnlyFlagsStore implements ReplayOnlyFlagsStore {
  private flags: Map<string, boolean> = new Map();

  private key(scopeType: ReplayOnlyScopeType, scopeId: string): string {
    return `${scopeType}:${scopeId}`;
  }

  async setFlag(scopeType: ReplayOnlyScopeType, scopeId: string, replayOnly: boolean): Promise<void> {
    this.flags.set(this.key(scopeType, scopeId), replayOnly);
  }

  async getFlag(scopeType: ReplayOnlyScopeType, scopeId: string): Promise<boolean> {
    return this.flags.get(this.key(scopeType, scopeId)) ?? false;
  }

  async close(): Promise<void> {
    // No cleanup needed
  }
}

// ─── PostgreSQL Implementation ──────────────────────────────────────────────

export class PostgresReplayOnlyFlagsStore implements ReplayOnlyFlagsStore {
  private pool: pg.Pool;
  private initialized = false;

  constructor(config: { connectionString: string }) {
    this.pool = new Pool({ connectionString: config.connectionString });
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS replay_only_flags (
        scope_type VARCHAR(20) NOT NULL,
        scope_id VARCHAR(255) NOT NULL,
        replay_only BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (scope_type, scope_id)
      );

      CREATE INDEX IF NOT EXISTS idx_replay_only_flags_scope ON replay_only_flags(scope_type, scope_id);
    `);

    this.initialized = true;
  }

  async setFlag(scopeType: ReplayOnlyScopeType, scopeId: string, replayOnly: boolean): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO replay_only_flags (scope_type, scope_id, replay_only, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (scope_type, scope_id) DO UPDATE SET
         replay_only = EXCLUDED.replay_only,
         updated_at = EXCLUDED.updated_at`,
      [scopeType, scopeId, replayOnly]
    );
  }

  async getFlag(scopeType: ReplayOnlyScopeType, scopeId: string): Promise<boolean> {
    await this.init();
    const result = await this.pool.query(
      'SELECT replay_only FROM replay_only_flags WHERE scope_type = $1 AND scope_id = $2',
      [scopeType, scopeId]
    );
    if (result.rows.length === 0) return false;
    return Boolean(result.rows[0].replay_only);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ─── Factory Functions ──────────────────────────────────────────────────────

export function createInMemoryReplayOnlyFlagsStore(): ReplayOnlyFlagsStore {
  return new InMemoryReplayOnlyFlagsStore();
}

export function createPostgresReplayOnlyFlagsStore(config: { connectionString: string }): ReplayOnlyFlagsStore {
  return new PostgresReplayOnlyFlagsStore(config);
}

// ─── Resolver ────────────────────────────────────────────────────────────────

export interface ReplayOnlyResolveParams {
  orgId?: string;
  workflowId?: string;
  agentId?: string;
  runId?: string;
}

/**
 * Resolve the effective `replay_only` value for a run.
 *
 * Semantics (docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md §6 Q1 — PER-RUN claim
 * scope; §12/G12 — lock-if-any-true, i.e. OR-merge across scopes):
 *   - Returns true if ANY applicable scope's flag is true.
 *   - Compliance LOCKS and never unlocks — there is no scope that can
 *     override a true back to false; a deeper scope being false does not
 *     relax a shallower scope's true.
 *   - A missing flag row is false.
 *   - Missing ids are tolerated — that scope is simply skipped (not treated
 *     as true or false).
 */
export async function resolveEffectiveReplayOnly(
  store: ReplayOnlyFlagsStore,
  params: ReplayOnlyResolveParams
): Promise<boolean> {
  const checks: Array<Promise<boolean>> = [];
  if (params.orgId) checks.push(store.getFlag('org', params.orgId));
  if (params.workflowId) checks.push(store.getFlag('workflow', params.workflowId));
  if (params.agentId) checks.push(store.getFlag('agent', params.agentId));
  if (params.runId) checks.push(store.getFlag('run', params.runId));

  if (checks.length === 0) return false;

  const results = await Promise.all(checks);
  return results.some(Boolean);
}
