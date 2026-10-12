/**
 * Evidence Store
 *
 * Combines metadata storage with content storage backend.
 *
 * QF-MT WP5: reads (`get/getContent/list/count/delete/getByEnvelopeId/
 * getByCorrelationId`) are org-scoped — mirrors envelope-store.ts's pattern
 * (only evidence.ts and tool-envelope.ts's dedup check call these, so the
 * blast radius of a mandatory scope param is fully contained). Writes
 * (`store`) take an OPTIONAL `orgId` on CreateEvidenceRequest — see that
 * type's docstring for why this deliberately deviates from the
 * compile-required pattern used by workflow-store/execution-store.
 */

import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { Pool } from 'pg';
import {
  EvidenceRecord,
  EvidenceRecordSchema,
  EvidenceStore,
  EvidenceListOptions,
  EvidenceStorageBackend,
  CreateEvidenceRequest,
  EvidenceOrgScope,
} from './types.js';
import { SYSTEM_SCOPE } from '../api/middleware/org-scope.js';

/** Sentinel org_id value legacy/system-authored rows fall to — mirrors the
 * Postgres column's `DEFAULT 'default'` (plan §5). */
const LEGACY_ORG_ID = 'default';

/** Resolve the org_id value to persist for a write. Absent/SYSTEM_SCOPE
 * writes are stamped with the legacy sentinel — visible to SYSTEM_SCOPE
 * reads only. */
function resolveWriteOrgId(orgId: string | undefined): string {
  return orgId ?? LEGACY_ORG_ID;
}

/** True when a stored row's org matches the caller's scope. SYSTEM_SCOPE
 * matches everything (explicit cross-org). Tenant scopes never match legacy/
 * undefined rows — unbackfilled rows are hidden, not leaked. */
function orgMatches(rowOrgId: string | undefined, scope: EvidenceOrgScope): boolean {
  if (scope === SYSTEM_SCOPE) return true;
  if (rowOrgId === undefined || rowOrgId === LEGACY_ORG_ID) return false;
  return rowOrgId === scope;
}

// ============================================================================
// Evidence Hash Chain (AUDIT-REAL #5)
// ============================================================================
//
// Evidence rows are chained per correlationId (chosen over workflowId /
// executionId because correlationId is required on every row — workflow /
// execution ids are optional and absent for non-workflow evidence such as
// skill_* telemetry — and because it identifies a single logical "run" that
// parallel, unrelated runs never share, avoiding contention on a global
// chain).
//
// Preimage / spec: chain_hash = sha256(`${prevHash ?? ''}:${hash}:${id}:${createdAt}`)
//   - prevHash: chain_hash of the previous row in the same correlationId
//     scope, or '' for the genesis row (no prior row in scope).
//   - hash: the row's own sha256 content hash (existing `hash` column).
//   - id / createdAt: bind the link to this specific row's identity so the
//     chain can't be replayed against a different row with the same hash.
//
// Rows written before this feature shipped have prevHash/chainHash = null
// ("legacy") and are not retroactively chained.

/**
 * Computes the chain_hash for one evidence row. Exported so tests (and any
 * future verification tooling) recompute with the exact same preimage as the
 * insert path — see module comment above for the spec.
 */
export function computeEvidenceChainHash(
  prevHash: string | null,
  hash: string,
  id: string,
  createdAt: string
): string {
  return createHash('sha256')
    .update(`${prevHash ?? ''}:${hash}:${id}:${createdAt}`)
    .digest('hex');
}

export interface EvidenceChainVerification {
  valid: boolean;
  /** Number of chained (non-legacy) rows recomputed and checked. */
  checked: number;
  /** Number of legacy rows (chain_hash IS NULL) skipped, not counted as failures. */
  legacy: number;
  /** id of the first row where the chain broke, or null if valid. */
  break_at: string | null;
}

/**
 * Walks the evidence hash chain for a given correlationId scope in insert
 * order (created_at, id) and recomputes each chain_hash to confirm no row
 * has been deleted, reordered, or tampered with since it was written.
 *
 * Legacy rows (chain_hash IS NULL, predating this feature) are skipped and
 * counted separately — they do not break the chain and are not failures.
 */
export async function verifyEvidenceChain(
  pool: Pool,
  scope: string
): Promise<EvidenceChainVerification> {
  const result = await pool.query(
    `SELECT id, hash, prev_hash, chain_hash, created_at
     FROM evidence
     WHERE correlation_id = $1
     ORDER BY created_at ASC, id ASC`,
    [scope]
  );

  let expectedPrevHash: string | null = null;
  let checked = 0;
  let legacy = 0;

  for (const row of result.rows) {
    if (row.chain_hash === null) {
      legacy++;
      continue;
    }

    const createdAt = (row.created_at as Date).toISOString();

    // Defense in depth: the stored prev_hash column must match the chain we
    // derived by walking prior rows — catches direct tampering of prev_hash
    // even if chain_hash were left untouched.
    if (row.prev_hash !== expectedPrevHash) {
      return { valid: false, checked, legacy, break_at: row.id };
    }

    const recomputed = computeEvidenceChainHash(expectedPrevHash, row.hash, row.id, createdAt);
    if (recomputed !== row.chain_hash) {
      return { valid: false, checked, legacy, break_at: row.id };
    }

    checked++;
    expectedPrevHash = row.chain_hash;
  }

  return { valid: true, checked, legacy, break_at: null };
}

// ============================================================================
// In-Memory Evidence Store
// ============================================================================

export class InMemoryEvidenceStore implements EvidenceStore {
  private records: Map<string, EvidenceRecord> = new Map();
  private backend: EvidenceStorageBackend;

  constructor(backend: EvidenceStorageBackend) {
    this.backend = backend;
  }

  async init(): Promise<void> {
    await this.backend.init();
  }

  async store(request: CreateEvidenceRequest): Promise<EvidenceRecord> {
    const id = ulid();
    const content = typeof request.content === 'string'
      ? Buffer.from(request.content)
      : request.content;

    // Calculate hash
    const hash = createHash('sha256').update(content).digest('hex');

    // Store content
    const storagePath = await this.backend.store(id, content);
    const createdAt = new Date().toISOString();

    // Hash chain (AUDIT-REAL #5): find the most recently inserted record in
    // the same correlationId scope (Map preserves insertion order) and chain
    // off its chain_hash. No cross-request race window here — this store is
    // in-memory / single-process and used for dev/test, not the audited
    // production path (see PostgresEvidenceStore for the transactional
    // version with real concurrency guarantees).
    let prevHash: string | null = null;
    for (const existing of this.records.values()) {
      if (existing.correlationId === request.correlationId && existing.chainHash) {
        prevHash = existing.chainHash;
      }
    }
    const chainHash = computeEvidenceChainHash(prevHash, hash, id, createdAt);

    const record: EvidenceRecord = {
      id,
      orgId: resolveWriteOrgId(request.orgId),
      correlationId: request.correlationId,
      envelopeId: request.envelopeId,
      workflowId: request.workflowId,
      executionId: request.executionId,
      nodeId: request.nodeId,
      type: request.type,
      contentType: request.contentType,
      size: content.length,
      hash,
      storageBackend: this.backend.type,
      storagePath,
      createdAt,
      expiresAt: request.expiresAt,
      metadata: request.metadata,
      prevHash: prevHash ?? undefined,
      chainHash,
    };

    this.records.set(id, record);
    return record;
  }

  async get(id: string, scope: EvidenceOrgScope): Promise<EvidenceRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;
    if (!orgMatches(record.orgId, scope)) return null;
    return record;
  }

  async getContent(id: string, scope: EvidenceOrgScope): Promise<Buffer | null> {
    const record = this.records.get(id);
    if (!record) return null;
    if (!orgMatches(record.orgId, scope)) return null;

    try {
      return await this.backend.retrieve(record.storagePath);
    } catch {
      return null;
    }
  }

  async list(options: EvidenceListOptions | undefined, scope: EvidenceOrgScope): Promise<EvidenceRecord[]> {
    options = options ?? {};
    let records = Array.from(this.records.values()).filter(r => orgMatches(r.orgId, scope));

    if (options.correlationId) {
      records = records.filter(r => r.correlationId === options.correlationId);
    }

    if (options.envelopeId) {
      records = records.filter(r => r.envelopeId === options.envelopeId);
    }

    if (options.workflowId) {
      records = records.filter(r => r.workflowId === options.workflowId);
    }

    if (options.executionId) {
      records = records.filter(r => r.executionId === options.executionId);
    }

    if (options.type) {
      records = records.filter(r => r.type === options.type);
    }

    // Sort by createdAt (newest first)
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const offset = options.offset ?? 0;
    const limit = options.limit ?? records.length;
    return records.slice(offset, offset + limit);
  }

  async count(options: Omit<EvidenceListOptions, 'limit' | 'offset'> | undefined, scope: EvidenceOrgScope): Promise<number> {
    const records = await this.list(options, scope);
    return records.length;
  }

  async delete(id: string, scope: EvidenceOrgScope): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || !orgMatches(record.orgId, scope)) return false;

    await this.backend.delete(record.storagePath);
    return this.records.delete(id);
  }

  async deleteExpired(): Promise<number> {
    const now = new Date();
    let deletedCount = 0;

    for (const [id, record] of this.records.entries()) {
      if (record.expiresAt && new Date(record.expiresAt) < now) {
        await this.backend.delete(record.storagePath);
        this.records.delete(id);
        deletedCount++;
      }
    }

    return deletedCount;
  }

  async getByEnvelopeId(envelopeId: string, scope: EvidenceOrgScope): Promise<EvidenceRecord[]> {
    return this.list({ envelopeId }, scope);
  }

  async getByCorrelationId(correlationId: string, scope: EvidenceOrgScope): Promise<EvidenceRecord[]> {
    return this.list({ correlationId }, scope);
  }

  async close(): Promise<void> {
    await this.backend.close();
  }
}

// ============================================================================
// PostgreSQL Evidence Store
// ============================================================================

export class PostgresEvidenceStore implements EvidenceStore {
  private pool: Pool;
  private backend: EvidenceStorageBackend;
  private initialized = false;

  constructor(config: { connectionString: string }, backend: EvidenceStorageBackend) {
    this.pool = new Pool({ connectionString: config.connectionString });
    this.backend = backend;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    await this.backend.init();

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS evidence (
        id VARCHAR(26) PRIMARY KEY,
        org_id VARCHAR(255) NOT NULL DEFAULT 'default',
        correlation_id VARCHAR(255) NOT NULL,
        envelope_id VARCHAR(26) NOT NULL,
        workflow_id VARCHAR(100),
        execution_id VARCHAR(26),
        node_id VARCHAR(100),
        type VARCHAR(50) NOT NULL,
        content_type VARCHAR(255) NOT NULL,
        size INTEGER NOT NULL,
        hash VARCHAR(64) NOT NULL,
        storage_backend VARCHAR(20) NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ,
        metadata JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_org_id ON evidence(org_id);
      CREATE INDEX IF NOT EXISTS idx_evidence_correlation ON evidence(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_evidence_envelope ON evidence(envelope_id);
      CREATE INDEX IF NOT EXISTS idx_evidence_workflow ON evidence(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_evidence_expires ON evidence(expires_at) WHERE expires_at IS NOT NULL;
    `);

    // AUDIT-REAL #5: hash-chain columns (idempotent — IF NOT EXISTS). Also
    // shipped as migrations/017-evidence-prev-hash.sql for deployments where
    // the table already exists when migrations run; both are no-ops against
    // each other. See computeEvidenceChainHash() / verifyEvidenceChain()
    // above for the chain spec.
    await this.pool.query(`
      ALTER TABLE evidence ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64);
      ALTER TABLE evidence ADD COLUMN IF NOT EXISTS chain_hash VARCHAR(64);
      CREATE INDEX IF NOT EXISTS idx_evidence_correlation_chain_order
        ON evidence (correlation_id, created_at, id);
    `);

    this.initialized = true;
  }

  async store(request: CreateEvidenceRequest): Promise<EvidenceRecord> {
    const id = ulid();
    const content = typeof request.content === 'string'
      ? Buffer.from(request.content)
      : request.content;

    const hash = createHash('sha256').update(content).digest('hex');
    const storagePath = await this.backend.store(id, content);

    // Hash chain (AUDIT-REAL #5): serialize read-latest-then-insert per
    // correlationId scope with a Postgres advisory lock so two concurrent
    // inserts in the same scope can never both read the same "latest"
    // chain_hash and fork the chain. pg_advisory_xact_lock is held for the
    // duration of the transaction and released automatically on
    // COMMIT/ROLLBACK. hashtext() collapses the scope string to an int4,
    // which is safe here — a false-positive lock collision between two
    // different correlationIds only costs a bit of serialization, never
    // correctness.
    //
    // createdAt is deliberately generated AFTER the lock is acquired, not at
    // the top of this function — verifyEvidenceChain() orders rows by
    // (created_at, id) to reconstruct insert order, so the timestamp must be
    // assigned only once this insert has exclusive access to the scope's
    // chain. Generating it earlier (before queueing on the lock) could let a
    // request that acquires the lock second still stamp an earlier
    // created_at than one that acquired it first, desynchronizing the
    // ORDER BY from the true chain order and producing false breaks.
    const client = await this.pool.connect();
    let createdAt: string;
    let prevHash: string | null = null;
    let chainHash: string;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [request.correlationId]);
      createdAt = new Date().toISOString();

      const latest = await client.query<{ chain_hash: string | null }>(
        `SELECT chain_hash FROM evidence
         WHERE correlation_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [request.correlationId]
      );
      prevHash = latest.rows[0]?.chain_hash ?? null;
      chainHash = computeEvidenceChainHash(prevHash, hash, id, createdAt);

      await client.query(
        `INSERT INTO evidence (
          id, org_id, correlation_id, envelope_id, workflow_id, execution_id, node_id,
          type, content_type, size, hash, storage_backend, storage_path,
          created_at, expires_at, metadata, prev_hash, chain_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          id,
          resolveWriteOrgId(request.orgId),
          request.correlationId,
          request.envelopeId,
          request.workflowId,
          request.executionId,
          request.nodeId,
          request.type,
          request.contentType,
          content.length,
          hash,
          this.backend.type,
          storagePath,
          createdAt,
          request.expiresAt,
          request.metadata ? JSON.stringify(request.metadata) : null,
          prevHash,
          chainHash,
        ]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const record: EvidenceRecord = {
      id,
      orgId: resolveWriteOrgId(request.orgId),
      correlationId: request.correlationId,
      envelopeId: request.envelopeId,
      workflowId: request.workflowId,
      executionId: request.executionId,
      nodeId: request.nodeId,
      type: request.type,
      contentType: request.contentType,
      size: content.length,
      hash,
      storageBackend: this.backend.type,
      storagePath,
      createdAt,
      expiresAt: request.expiresAt,
      metadata: request.metadata,
      prevHash: prevHash ?? undefined,
      chainHash,
    };

    return record;
  }

  async get(id: string, scope: EvidenceOrgScope): Promise<EvidenceRecord | null> {
    const params: unknown[] = [id];
    let query = 'SELECT * FROM evidence WHERE id = $1';
    if (scope !== SYSTEM_SCOPE) {
      query += ' AND org_id = $2';
      params.push(scope);
    }

    const result = await this.pool.query(query, params);

    if (result.rows.length === 0) return null;
    return this.rowToRecord(result.rows[0]);
  }

  async getContent(id: string, scope: EvidenceOrgScope): Promise<Buffer | null> {
    const record = await this.get(id, scope);
    if (!record) return null;

    try {
      return await this.backend.retrieve(record.storagePath);
    } catch {
      return null;
    }
  }

  async list(options: EvidenceListOptions | undefined, scope: EvidenceOrgScope): Promise<EvidenceRecord[]> {
    options = options ?? {};
    let query = 'SELECT * FROM evidence WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (scope !== SYSTEM_SCOPE) {
      query += ` AND org_id = $${paramIndex++}`;
      params.push(scope);
    }

    if (options.correlationId) {
      query += ` AND correlation_id = $${paramIndex++}`;
      params.push(options.correlationId);
    }

    if (options.envelopeId) {
      query += ` AND envelope_id = $${paramIndex++}`;
      params.push(options.envelopeId);
    }

    if (options.workflowId) {
      query += ` AND workflow_id = $${paramIndex++}`;
      params.push(options.workflowId);
    }

    if (options.executionId) {
      query += ` AND execution_id = $${paramIndex++}`;
      params.push(options.executionId);
    }

    if (options.type) {
      query += ` AND type = $${paramIndex++}`;
      params.push(options.type);
    }

    query += ' ORDER BY created_at DESC';

    if (options.limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options.offset) {
      query += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const result = await this.pool.query(query, params);
    return result.rows.map(row => this.rowToRecord(row));
  }

  async count(options: Omit<EvidenceListOptions, 'limit' | 'offset'> | undefined, scope: EvidenceOrgScope): Promise<number> {
    options = options ?? {};
    let query = 'SELECT COUNT(*) FROM evidence WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (scope !== SYSTEM_SCOPE) {
      query += ` AND org_id = $${paramIndex++}`;
      params.push(scope);
    }

    if (options.correlationId) {
      query += ` AND correlation_id = $${paramIndex++}`;
      params.push(options.correlationId);
    }

    if (options.envelopeId) {
      query += ` AND envelope_id = $${paramIndex++}`;
      params.push(options.envelopeId);
    }

    if (options.workflowId) {
      query += ` AND workflow_id = $${paramIndex++}`;
      params.push(options.workflowId);
    }

    if (options.executionId) {
      query += ` AND execution_id = $${paramIndex++}`;
      params.push(options.executionId);
    }

    if (options.type) {
      query += ` AND type = $${paramIndex++}`;
      params.push(options.type);
    }

    const result = await this.pool.query(query, params);
    return parseInt(result.rows[0].count, 10);
  }

  async delete(id: string, scope: EvidenceOrgScope): Promise<boolean> {
    const record = await this.get(id, scope);
    if (!record) return false;

    await this.backend.delete(record.storagePath);

    const params: unknown[] = [id];
    let query = 'DELETE FROM evidence WHERE id = $1';
    if (scope !== SYSTEM_SCOPE) {
      query += ' AND org_id = $2';
      params.push(scope);
    }

    const result = await this.pool.query(query, params);

    return (result.rowCount ?? 0) > 0;
  }

  async deleteExpired(): Promise<number> {
    // Get expired records first
    const expiredResult = await this.pool.query(
      'SELECT storage_path FROM evidence WHERE expires_at IS NOT NULL AND expires_at < NOW()'
    );

    // Delete content from backend
    for (const row of expiredResult.rows) {
      try {
        await this.backend.delete(row.storage_path);
      } catch {
        // Ignore deletion errors
      }
    }

    // Delete records
    const result = await this.pool.query(
      'DELETE FROM evidence WHERE expires_at IS NOT NULL AND expires_at < NOW()'
    );

    return result.rowCount ?? 0;
  }

  async getByEnvelopeId(envelopeId: string, scope: EvidenceOrgScope): Promise<EvidenceRecord[]> {
    return this.list({ envelopeId }, scope);
  }

  async getByCorrelationId(correlationId: string, scope: EvidenceOrgScope): Promise<EvidenceRecord[]> {
    return this.list({ correlationId }, scope);
  }

  async close(): Promise<void> {
    await this.backend.close();
    await this.pool.end();
  }

  private rowToRecord(row: Record<string, unknown>): EvidenceRecord {
    return EvidenceRecordSchema.parse({
      id: row.id,
      orgId: row.org_id ?? undefined,
      correlationId: row.correlation_id,
      envelopeId: row.envelope_id,
      // SQL NULL must become undefined — the schema's .optional() fields
      // reject null, which turned any legacy row with absent workflow/
      // execution/node linkage into a ZodError (bare 400) on read.
      workflowId: row.workflow_id ?? undefined,
      executionId: row.execution_id ?? undefined,
      nodeId: row.node_id ?? undefined,
      type: row.type,
      contentType: row.content_type,
      size: row.size,
      hash: row.hash,
      storageBackend: row.storage_backend,
      storagePath: row.storage_path,
      createdAt: (row.created_at as Date)?.toISOString(),
      expiresAt: row.expires_at ? (row.expires_at as Date).toISOString() : undefined,
      metadata: row.metadata ?? undefined,
      prevHash: row.prev_hash ?? undefined,
      chainHash: row.chain_hash ?? undefined,
    });
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createInMemoryEvidenceStore(backend: EvidenceStorageBackend): EvidenceStore {
  return new InMemoryEvidenceStore(backend);
}

export function createPostgresEvidenceStore(
  config: { connectionString: string },
  backend: EvidenceStorageBackend
): EvidenceStore {
  return new PostgresEvidenceStore(config, backend);
}
