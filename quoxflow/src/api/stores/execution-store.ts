/**
 * Execution Store
 *
 * Persistence layer for execution metadata.
 * Links executions to their envelope audit trails via correlation ID.
 *
 * QF-MT WP5: every read/write is org-scoped, mirroring the workflow-store
 * pattern (WP3, see api/stores/workflow-store.ts module docstring). Reads
 * take `scope: ExecutionOrgScope` (`string | typeof SYSTEM_SCOPE`) and filter
 * unless SYSTEM_SCOPE is passed explicitly; writes persist the caller's org.
 * Legacy rows (org_id = 'default', or untracked in the in-memory store) are
 * visible to SYSTEM_SCOPE only. Cross-org by-id reads return null (routes
 * turn that into 404 — never a thrown 403).
 */

import { Pool, PoolConfig } from 'pg';
import { ulid } from 'ulid';
import { SYSTEM_SCOPE, SystemScope } from '../middleware/org-scope.js';

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';

/** Org scope accepted by every ExecutionStore method — string org id, or the
 * explicit cross-org SYSTEM_SCOPE sentinel (never an absent parameter). */
export type ExecutionOrgScope = string | SystemScope;

/** Sentinel org_id value legacy/system-authored rows fall to. Mirrors the
 * Postgres column's `DEFAULT 'default'` — kept as the literal string so
 * legacy rows and SYSTEM_SCOPE-authored rows share one hidden-from-tenants
 * bucket (plan §5). */
const LEGACY_ORG_ID = 'default';

/** Resolve the org_id value to persist for a write. SYSTEM_SCOPE writes are
 * stamped with the legacy sentinel — visible to SYSTEM_SCOPE reads only. */
function resolveWriteOrgId(scope: ExecutionOrgScope): string {
  return scope === SYSTEM_SCOPE ? LEGACY_ORG_ID : scope;
}

/** True when a stored row's org matches the caller's scope. SYSTEM_SCOPE
 * matches everything (explicit cross-org). Tenant scopes never match legacy/
 * undefined rows — unbackfilled rows are hidden, not leaked. */
function orgMatches(rowOrgId: string | undefined, scope: ExecutionOrgScope): boolean {
  if (scope === SYSTEM_SCOPE) return true;
  if (rowOrgId === undefined || rowOrgId === LEGACY_ORG_ID) return false;
  return rowOrgId === scope;
}

export interface StoredExecution {
  id: string;
  /** Tenant owner of this execution. Populated from the org_id column in Postgres. */
  orgId?: string;
  workflowId: string;
  workflowName: string;
  correlationId: string;
  status: ExecutionStatus;
  triggerData?: unknown;
  output?: unknown;
  error?: { code: string; message: string; details?: unknown };
  startedAt: string;
  completedAt?: string;
  duration?: number;
  nodeCount?: number;
  envelopeCount?: number;
  triggeredBy?: string;
  metadata?: Record<string, unknown>;
  /** AEE-FULL Gap 4: cancellation fields */
  cancelledAt?: string;
  cancelledBy?: 'user' | 'system' | 'timeout';
  cancellationReason?: string;
}

export interface ExecutionStoreConfig {
  connectionString?: string;
  poolConfig?: PoolConfig;
}

export interface ListExecutionsOptions {
  workflowId?: string;
  status?: ExecutionStatus;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface ExecutionStore {
  init(): Promise<void>;
  /** id is optional — if provided it is used as-is; if absent a new ULID is generated. */
  create(execution: Omit<StoredExecution, 'id' | 'orgId'> & { id?: string }, scope: ExecutionOrgScope): Promise<StoredExecution>;
  get(id: string, scope: ExecutionOrgScope): Promise<StoredExecution | null>;
  getByCorrelation(correlationId: string, scope: ExecutionOrgScope): Promise<StoredExecution | null>;
  list(scope: ExecutionOrgScope, options?: ListExecutionsOptions): Promise<StoredExecution[]>;
  count(scope: ExecutionOrgScope, options?: Omit<ListExecutionsOptions, 'limit' | 'offset'>): Promise<number>;
  /**
   * Cross-org update is rejected (throws, same as not-found — see
   * module docstring). Internal callers that already resolved/verified
   * ownership (e.g. ExecutionService continuing an execution it just
   * created) may pass SYSTEM_SCOPE.
   */
  update(id: string, scope: ExecutionOrgScope, updates: Partial<StoredExecution>): Promise<StoredExecution>;
  /**
   * R5.crit-1: Fail all executions with the given status that started before
   * olderThan. Used at boot to clean up executions left in a non-terminal
   * state from a prior crash. Deliberately cross-org (boot-time maintenance
   * sweep, not exposed via any route) — no scope parameter.
   * Returns the number of rows transitioned.
   */
  failStale(status: ExecutionStatus, olderThan: Date): Promise<number>;
  close(): Promise<void>;
}

/**
 * In-memory execution store for testing
 */
export class InMemoryExecutionStore implements ExecutionStore {
  private executions = new Map<string, StoredExecution>();
  private byCorrelation = new Map<string, string>();

  async init(): Promise<void> {
    // No initialization needed
  }

  async create(execution: Omit<StoredExecution, 'id' | 'orgId'> & { id?: string }, scope: ExecutionOrgScope): Promise<StoredExecution> {
    const id = execution.id || ulid();
    const { id: _ignored, ...rest } = execution as typeof execution & { id?: string };
    const stored: StoredExecution = {
      id,
      orgId: resolveWriteOrgId(scope),
      ...rest,
    };

    this.executions.set(id, stored);
    if (execution.correlationId) {
      this.byCorrelation.set(execution.correlationId, id);
    }

    return stored;
  }

  async get(id: string, scope: ExecutionOrgScope): Promise<StoredExecution | null> {
    const stored = this.executions.get(id);
    if (!stored) return null;
    if (!orgMatches(stored.orgId, scope)) return null;
    return stored;
  }

  async getByCorrelation(correlationId: string, scope: ExecutionOrgScope): Promise<StoredExecution | null> {
    const id = this.byCorrelation.get(correlationId);
    if (!id) return null;
    const stored = this.executions.get(id);
    if (!stored) return null;
    if (!orgMatches(stored.orgId, scope)) return null;
    return stored;
  }

  async list(scope: ExecutionOrgScope, options?: ListExecutionsOptions): Promise<StoredExecution[]> {
    let executions = Array.from(this.executions.values()).filter(e => orgMatches(e.orgId, scope));

    if (options?.workflowId) {
      executions = executions.filter(e => e.workflowId === options.workflowId);
    }

    if (options?.status) {
      executions = executions.filter(e => e.status === options.status);
    }

    if (options?.since) {
      const since = options.since.toISOString();
      executions = executions.filter(e => e.startedAt >= since);
    }

    if (options?.until) {
      const until = options.until.toISOString();
      executions = executions.filter(e => e.startedAt <= until);
    }

    // Sort by startedAt descending
    executions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const offset = options?.offset || 0;
    const limit = options?.limit || 100;

    return executions.slice(offset, offset + limit);
  }

  async count(scope: ExecutionOrgScope, options?: Omit<ListExecutionsOptions, 'limit' | 'offset'>): Promise<number> {
    const list = await this.list(scope, options);
    return list.length;
  }

  async update(id: string, scope: ExecutionOrgScope, updates: Partial<StoredExecution>): Promise<StoredExecution> {
    const existing = this.executions.get(id);
    if (!existing || !orgMatches(existing.orgId, scope)) {
      throw new Error(`Execution ${id} not found`);
    }

    const updated: StoredExecution = {
      ...existing,
      ...updates,
      id, // Prevent ID override
      orgId: existing.orgId, // org is immutable via update()
    };

    this.executions.set(id, updated);

    // Update correlation index if changed
    if (updates.correlationId && updates.correlationId !== existing.correlationId) {
      this.byCorrelation.delete(existing.correlationId);
      this.byCorrelation.set(updates.correlationId, id);
    }

    return updated;
  }

  async failStale(status: ExecutionStatus, olderThan: Date): Promise<number> {
    let count = 0;
    const olderThanIso = olderThan.toISOString();
    for (const [id, execution] of this.executions) {
      if (execution.status === status && execution.startedAt < olderThanIso) {
        const updated: StoredExecution = {
          ...execution,
          status: 'failed',
          error: { code: 'STALE_EXECUTION', message: `Execution found in '${status}' state at startup — assumed crashed` },
          completedAt: new Date().toISOString(),
        };
        this.executions.set(id, updated);
        count++;
      }
    }
    return count;
  }

  async close(): Promise<void> {
    this.executions.clear();
    this.byCorrelation.clear();
  }
}

/**
 * PostgreSQL execution store
 */
export class PostgresExecutionStore implements ExecutionStore {
  private pool: Pool;

  constructor(config: ExecutionStoreConfig) {
    this.pool = new Pool(
      config.connectionString
        ? { connectionString: config.connectionString }
        : config.poolConfig
    );
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS executions (
        id VARCHAR(26) PRIMARY KEY,
        org_id VARCHAR(255) NOT NULL DEFAULT 'default',
        workflow_id VARCHAR(100) NOT NULL,
        workflow_name VARCHAR(255) NOT NULL,
        correlation_id VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(20) NOT NULL,
        trigger_data JSONB,
        output JSONB,
        error JSONB,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        duration INTEGER,
        node_count INTEGER,
        envelope_count INTEGER,
        triggered_by VARCHAR(255),
        metadata JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_executions_org_id ON executions(org_id);
      CREATE INDEX IF NOT EXISTS idx_executions_workflow_id ON executions(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_executions_correlation_id ON executions(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
      CREATE INDEX IF NOT EXISTS idx_executions_started_at ON executions(started_at);
    `);

    // AEE-FULL Gap 4: cancellation columns (idempotent — IF NOT EXISTS)
    await this.pool.query(`
      ALTER TABLE executions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
      ALTER TABLE executions ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(20);
      ALTER TABLE executions ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
    `);
  }

  async create(execution: Omit<StoredExecution, 'id' | 'orgId'> & { id?: string }, scope: ExecutionOrgScope): Promise<StoredExecution> {
    const id = execution.id || ulid();
    const orgId = resolveWriteOrgId(scope);

    const result = await this.pool.query(
      `
      INSERT INTO executions (
        id, org_id, workflow_id, workflow_name, correlation_id, status,
        trigger_data, output, error, started_at, completed_at,
        duration, node_count, envelope_count, triggered_by, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *
      `,
      [
        id,
        orgId,
        execution.workflowId,
        execution.workflowName,
        execution.correlationId,
        execution.status,
        execution.triggerData ? JSON.stringify(execution.triggerData) : null,
        execution.output ? JSON.stringify(execution.output) : null,
        execution.error ? JSON.stringify(execution.error) : null,
        execution.startedAt,
        execution.completedAt,
        execution.duration,
        execution.nodeCount,
        execution.envelopeCount,
        execution.triggeredBy,
        execution.metadata ? JSON.stringify(execution.metadata) : null,
      ]
    );

    return this.mapRow(result.rows[0]);
  }

  async get(id: string, scope: ExecutionOrgScope): Promise<StoredExecution | null> {
    const params: unknown[] = [id];
    let query = 'SELECT * FROM executions WHERE id = $1';
    if (scope !== SYSTEM_SCOPE) {
      query += ' AND org_id = $2';
      params.push(scope);
    }

    const result = await this.pool.query(query, params);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  async getByCorrelation(correlationId: string, scope: ExecutionOrgScope): Promise<StoredExecution | null> {
    const params: unknown[] = [correlationId];
    let query = 'SELECT * FROM executions WHERE correlation_id = $1';
    if (scope !== SYSTEM_SCOPE) {
      query += ' AND org_id = $2';
      params.push(scope);
    }

    const result = await this.pool.query(query, params);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  async list(scope: ExecutionOrgScope, options?: ListExecutionsOptions): Promise<StoredExecution[]> {
    let query = 'SELECT * FROM executions';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (scope !== SYSTEM_SCOPE) {
      conditions.push(`org_id = $${params.length + 1}`);
      params.push(scope);
    }

    if (options?.workflowId) {
      conditions.push(`workflow_id = $${params.length + 1}`);
      params.push(options.workflowId);
    }

    if (options?.status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(options.status);
    }

    if (options?.since) {
      conditions.push(`started_at >= $${params.length + 1}`);
      params.push(options.since);
    }

    if (options?.until) {
      conditions.push(`started_at <= $${params.length + 1}`);
      params.push(options.until);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY started_at DESC';

    if (options?.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ` OFFSET $${params.length + 1}`;
      params.push(options.offset);
    }

    const result = await this.pool.query(query, params);
    return result.rows.map(row => this.mapRow(row));
  }

  async count(scope: ExecutionOrgScope, options?: Omit<ListExecutionsOptions, 'limit' | 'offset'>): Promise<number> {
    let query = 'SELECT COUNT(*) FROM executions';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (scope !== SYSTEM_SCOPE) {
      conditions.push(`org_id = $${params.length + 1}`);
      params.push(scope);
    }

    if (options?.workflowId) {
      conditions.push(`workflow_id = $${params.length + 1}`);
      params.push(options.workflowId);
    }

    if (options?.status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(options.status);
    }

    if (options?.since) {
      conditions.push(`started_at >= $${params.length + 1}`);
      params.push(options.since);
    }

    if (options?.until) {
      conditions.push(`started_at <= $${params.length + 1}`);
      params.push(options.until);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    const result = await this.pool.query(query, params);
    return parseInt(result.rows[0].count, 10);
  }

  async update(id: string, scope: ExecutionOrgScope, updates: Partial<StoredExecution>): Promise<StoredExecution> {
    const setClauses: string[] = [];
    const params: unknown[] = [id];

    if (updates.correlationId !== undefined) {
      setClauses.push(`correlation_id = $${params.length + 1}`);
      params.push(updates.correlationId);
    }

    if (updates.status !== undefined) {
      setClauses.push(`status = $${params.length + 1}`);
      params.push(updates.status);
    }

    if (updates.output !== undefined) {
      setClauses.push(`output = $${params.length + 1}`);
      params.push(JSON.stringify(updates.output));
    }

    if (updates.error !== undefined) {
      setClauses.push(`error = $${params.length + 1}`);
      params.push(JSON.stringify(updates.error));
    }

    if (updates.completedAt !== undefined) {
      setClauses.push(`completed_at = $${params.length + 1}`);
      params.push(updates.completedAt);
    }

    if (updates.duration !== undefined) {
      setClauses.push(`duration = $${params.length + 1}`);
      params.push(updates.duration);
    }

    if (updates.nodeCount !== undefined) {
      setClauses.push(`node_count = $${params.length + 1}`);
      params.push(updates.nodeCount);
    }

    if (updates.envelopeCount !== undefined) {
      setClauses.push(`envelope_count = $${params.length + 1}`);
      params.push(updates.envelopeCount);
    }

    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${params.length + 1}`);
      params.push(JSON.stringify(updates.metadata));
    }

    if (updates.cancelledAt !== undefined) {
      setClauses.push(`cancelled_at = $${params.length + 1}`);
      params.push(updates.cancelledAt);
    }

    if (updates.cancelledBy !== undefined) {
      setClauses.push(`cancelled_by = $${params.length + 1}`);
      params.push(updates.cancelledBy);
    }

    if (updates.cancellationReason !== undefined) {
      setClauses.push(`cancellation_reason = $${params.length + 1}`);
      params.push(updates.cancellationReason);
    }

    if (setClauses.length === 0) {
      const existing = await this.get(id, scope);
      if (!existing) {
        throw new Error(`Execution ${id} not found`);
      }
      return existing;
    }

    let query = `UPDATE executions SET ${setClauses.join(', ')} WHERE id = $1`;
    if (scope !== SYSTEM_SCOPE) {
      query += ` AND org_id = $${params.length + 1}`;
      params.push(scope);
    }
    query += ' RETURNING *';

    const result = await this.pool.query(query, params);

    if (result.rows.length === 0) {
      throw new Error(`Execution ${id} not found`);
    }

    return this.mapRow(result.rows[0]);
  }

  async failStale(status: ExecutionStatus, olderThan: Date): Promise<number> {
    const errorPayload = JSON.stringify({
      code: 'STALE_EXECUTION',
      message: `Execution found in '${status}' state at startup — assumed crashed`,
    });
    const result = await this.pool.query(
      `UPDATE executions
          SET status = 'failed',
              error = $1,
              completed_at = NOW()
        WHERE status = $2
          AND started_at < $3
        RETURNING id`,
      [errorPayload, status, olderThan]
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private mapRow(row: Record<string, unknown>): StoredExecution {
    return {
      id: row.id as string,
      orgId: row.org_id as string | undefined,
      workflowId: row.workflow_id as string,
      workflowName: row.workflow_name as string,
      correlationId: row.correlation_id as string,
      status: row.status as ExecutionStatus,
      triggerData: row.trigger_data as unknown,
      output: row.output as unknown,
      error: row.error as { code: string; message: string; details?: unknown } | undefined,
      startedAt: (row.started_at as Date).toISOString(),
      completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : undefined,
      duration: row.duration as number | undefined,
      nodeCount: row.node_count as number | undefined,
      envelopeCount: row.envelope_count as number | undefined,
      triggeredBy: row.triggered_by as string | undefined,
      metadata: row.metadata as Record<string, unknown> | undefined,
      cancelledAt: row.cancelled_at ? (row.cancelled_at as Date).toISOString() : undefined,
      cancelledBy: row.cancelled_by as 'user' | 'system' | 'timeout' | undefined,
      cancellationReason: row.cancellation_reason as string | undefined,
    };
  }
}

export function createInMemoryExecutionStore(): ExecutionStore {
  return new InMemoryExecutionStore();
}

export function createExecutionStore(config: ExecutionStoreConfig): ExecutionStore {
  if (config.connectionString || config.poolConfig) {
    return new PostgresExecutionStore(config);
  }
  return new InMemoryExecutionStore();
}
