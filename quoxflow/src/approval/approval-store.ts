/**
 * Approval Store
 *
 * Persistence layer for approval requests.
 * Supports both PostgreSQL and in-memory storage.
 */

import { ulid } from 'ulid';
import { Pool } from 'pg';
import {
  ApprovalRequest,
  ApprovalRequestSchema,
  ApprovalStore,
  ApprovalListOptions,
  ApprovalResponse,
  CreateApprovalRequest,
  ApprovalOrgScope,
} from './types.js';
import { SYSTEM_SCOPE } from '../api/middleware/org-scope.js';

/** Sentinel org_id value legacy/system-authored rows fall to. Mirrors the
 * Postgres `approvals.org_id` column's existing `DEFAULT 'default'` — kept as
 * the literal string so legacy rows and SYSTEM_SCOPE-authored rows share one
 * hidden-from-tenants bucket (QF-MT plan §5, same pattern as workflow-store). */
const LEGACY_ORG_ID = 'default';

/**
 * Org to persist for a newly-created approval. QF-MT WP6: `create()` takes no
 * explicit scope parameter (unlike the other store methods) — every executor
 * that creates approvals during a run already threads `context.orgId` into
 * `request.metadata.orgId` (P8.F HITL-ORGID-PLUMB), so that's the run's org
 * source. Only the direct `POST /api/approvals` route lacks that metadata
 * field by default; approvals.ts stamps the resolved caller scope into
 * `metadata.orgId` before calling the engine, so this still holds for it.
 * Falls back to the legacy sentinel when absent (untagged/system-authored).
 */
function resolveCreateOrgId(request: CreateApprovalRequest): string {
  const fromMetadata = request.metadata?.orgId;
  return typeof fromMetadata === 'string' && fromMetadata.length > 0 ? fromMetadata : LEGACY_ORG_ID;
}

/** True when a stored row's org matches the caller's scope. SYSTEM_SCOPE
 * (passed explicitly by callers that legitimately need cross-org visibility)
 * matches everything. Tenant scopes never match legacy/undefined rows (§5 —
 * unbackfilled rows are hidden, not leaked). */
function orgMatches(rowOrgId: string | undefined, scope: ApprovalOrgScope): boolean {
  if (scope === SYSTEM_SCOPE) return true;
  if (rowOrgId === undefined || rowOrgId === LEGACY_ORG_ID) return false;
  return rowOrgId === scope;
}

// ============================================================================
// In-Memory Approval Store
// ============================================================================

export class InMemoryApprovalStore implements ApprovalStore {
  private approvals: Map<string, ApprovalRequest> = new Map();
  // Per-approval mutex chain: serialises concurrent approveMulti / denyMulti calls
  // that would otherwise race on the same approval row under Promise.all.
  private mutexChain: Map<string, Promise<unknown>> = new Map();

  async init(): Promise<void> {
    // No initialization needed for in-memory store
  }

  async create(request: CreateApprovalRequest): Promise<ApprovalRequest> {
    const now = new Date();
    const timeoutMs = request.timeoutMs ?? 86400000; // Default 24 hours

    const approval: ApprovalRequest = {
      id: ulid(),
      orgId: resolveCreateOrgId(request),
      correlationId: request.correlationId,
      workflowId: request.workflowId,
      workflowName: request.workflowName,
      executionId: request.executionId,
      nodeId: request.nodeId,
      trigger: request.trigger,
      approvers: request.approvers,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
      metadata: request.metadata,
    };

    this.approvals.set(approval.id, approval);
    return approval;
  }

  async get(id: string, scope: ApprovalOrgScope): Promise<ApprovalRequest | null> {
    const approval = this.approvals.get(id);
    if (!approval) return null;
    if (!orgMatches(approval.orgId, scope)) return null;
    return approval;
  }

  async getByCorrelationId(correlationId: string, scope: ApprovalOrgScope): Promise<ApprovalRequest | null> {
    for (const approval of this.approvals.values()) {
      if (approval.correlationId === correlationId && orgMatches(approval.orgId, scope)) {
        return approval;
      }
    }
    return null;
  }

  async list(options: ApprovalListOptions = {}, scope: ApprovalOrgScope): Promise<ApprovalRequest[]> {
    let approvals = Array.from(this.approvals.values()).filter(a => orgMatches(a.orgId, scope));

    // Filter by status
    if (options.status) {
      approvals = approvals.filter(a => a.status === options.status);
    }

    // Filter by workflow ID
    if (options.workflowId) {
      approvals = approvals.filter(a => a.workflowId === options.workflowId);
    }

    // Filter by correlation ID
    if (options.correlationId) {
      approvals = approvals.filter(a => a.correlationId === options.correlationId);
    }

    // Filter by approver
    if (options.approver) {
      approvals = approvals.filter(a => a.approvers.includes(options.approver!));
    }

    // Sort by createdAt (newest first)
    approvals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Pagination
    const offset = options.offset ?? 0;
    const limit = options.limit ?? approvals.length;
    return approvals.slice(offset, offset + limit);
  }

  async count(options: Omit<ApprovalListOptions, 'limit' | 'offset'> = {}, scope: ApprovalOrgScope): Promise<number> {
    const approvals = await this.list(options, scope);
    return approvals.length;
  }

  async resolve(id: string, response: ApprovalResponse, scope: ApprovalOrgScope): Promise<ApprovalRequest> {
    const approval = this.approvals.get(id);
    if (!approval || !orgMatches(approval.orgId, scope)) {
      throw new Error(`Approval not found: ${id}`);
    }

    if (approval.status !== 'pending') {
      throw new Error(`Approval ${id} is not pending (status: ${approval.status})`);
    }

    const updated: ApprovalRequest = {
      ...approval,
      status: response.decision,
      resolvedBy: response.approver,
      resolvedAt: response.timestamp,
      resolution: {
        decision: response.decision,
        comment: response.comment,
        metadata: response.metadata,
      },
    };

    this.approvals.set(id, updated);
    return updated;
  }

  async resolveMulti(id: string, response: ApprovalResponse, updatedMetadata: Record<string, unknown>): Promise<ApprovalRequest> {
    const approval = this.approvals.get(id);
    if (!approval) throw new Error(`Approval not found: ${id}`);
    if (approval.status !== 'pending') throw new Error(`Approval ${id} is not pending`);

    const updated: ApprovalRequest = {
      ...approval,
      status: response.decision,
      resolvedBy: response.approver,
      resolvedAt: response.timestamp,
      metadata: updatedMetadata,
      resolution: {
        decision: response.decision,
        comment: response.comment,
        metadata: response.metadata,
      },
    };

    this.approvals.set(id, updated);
    return updated;
  }

  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<ApprovalRequest> {
    const approval = this.approvals.get(id);
    if (!approval) throw new Error(`Approval not found: ${id}`);

    const updated: ApprovalRequest = { ...approval, metadata };
    this.approvals.set(id, updated);
    return updated;
  }

  /**
   * Atomically record a multi-stakeholder decision.
   * A mutex chain (one promise per approvalId) ensures concurrent calls
   * are serialised in the JS event loop — no two calls can read-modify-write
   * the same row simultaneously.
   */
  async recordMultiDecision(
    id: string,
    approver: string,
    decision: 'approved' | 'denied',
    comment?: string
  ): Promise<ApprovalRequest> {
    // Chain this call behind the previous one for the same approvalId
    const prior = this.mutexChain.get(id) ?? Promise.resolve();
    let resolveMutex!: () => void;
    const thisSlot = new Promise<void>(res => { resolveMutex = res; });
    this.mutexChain.set(id, prior.then(() => thisSlot));

    try {
      await prior; // wait for the previous operation to finish

      const approval = this.approvals.get(id);
      if (!approval) throw new Error(`Approval not found: ${id}`);

      // Idempotent: already resolved → return as-is
      if (approval.status !== 'pending') return approval;

      const threshold: number = ((approval.metadata as Record<string, unknown>)?.threshold as number) ?? 1;
      const existing: Array<{ approver: string; decision: string; timestamp: string; comment?: string }> =
        ((approval.metadata as Record<string, unknown>)?.decisions as Array<{ approver: string; decision: string; timestamp: string; comment?: string }>) ?? [];

      // Idempotent: this approver already voted
      if (existing.some(d => d.approver === approver)) return approval;

      const newEntry = { approver, decision, timestamp: new Date().toISOString(), comment };
      const decisions = [...existing, newEntry];
      const approveCount = decisions.filter(d => d.decision === 'approved').length;

      const updatedMetadata: Record<string, unknown> = {
        ...(approval.metadata ?? {}),
        decisions,
      };

      if (decision === 'denied' || approveCount >= threshold) {
        // Resolve immediately
        const finalDecision: 'approved' | 'denied' = decision === 'denied' ? 'denied' : 'approved';
        const updated: ApprovalRequest = {
          ...approval,
          status: finalDecision,
          resolvedBy: approver,
          resolvedAt: new Date().toISOString(),
          metadata: updatedMetadata,
          resolution: { decision: finalDecision, comment },
        };
        this.approvals.set(id, updated);
        return updated;
      }

      // Stay pending — just update decisions array
      const updated: ApprovalRequest = { ...approval, metadata: updatedMetadata };
      this.approvals.set(id, updated);
      return updated;
    } finally {
      resolveMutex();
    }
  }

  async cancel(id: string, scope: ApprovalOrgScope): Promise<ApprovalRequest> {
    const approval = this.approvals.get(id);
    if (!approval || !orgMatches(approval.orgId, scope)) {
      throw new Error(`Approval not found: ${id}`);
    }

    if (approval.status !== 'pending') {
      throw new Error(`Approval ${id} is not pending (status: ${approval.status})`);
    }

    const updated: ApprovalRequest = {
      ...approval,
      status: 'cancelled',
      resolvedAt: new Date().toISOString(),
    };

    this.approvals.set(id, updated);
    return updated;
  }

  async expireOld(): Promise<number> {
    const now = new Date();
    let expiredCount = 0;

    for (const [id, approval] of this.approvals.entries()) {
      if (approval.status === 'pending' && new Date(approval.expiresAt) < now) {
        this.approvals.set(id, {
          ...approval,
          status: 'expired',
          resolvedAt: now.toISOString(),
        });
        expiredCount++;
      }
    }

    return expiredCount;
  }

  async getPendingForApprover(approver: string, scope: ApprovalOrgScope): Promise<ApprovalRequest[]> {
    return this.list({ status: 'pending', approver }, scope);
  }

  async close(): Promise<void> {
    // No cleanup needed
  }
}

// ============================================================================
// PostgreSQL Approval Store
// ============================================================================

export class PostgresApprovalStore implements ApprovalStore {
  private pool: Pool;
  private initialized = false;

  constructor(config: { connectionString: string }) {
    this.pool = new Pool({ connectionString: config.connectionString });
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS approvals (
        id VARCHAR(26) PRIMARY KEY,
        org_id VARCHAR(255) NOT NULL DEFAULT 'default',
        correlation_id VARCHAR(255) NOT NULL,
        workflow_id VARCHAR(100) NOT NULL,
        workflow_name VARCHAR(255),
        execution_id VARCHAR(26) NOT NULL,
        node_id VARCHAR(100),
        trigger JSONB NOT NULL,
        approvers JSONB NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        resolved_by VARCHAR(255),
        resolved_at TIMESTAMPTZ,
        resolution JSONB,
        metadata JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_org_id ON approvals(org_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_correlation ON approvals(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_workflow ON approvals(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_expires ON approvals(expires_at) WHERE status = 'pending';
    `);

    this.initialized = true;
  }

  async create(request: CreateApprovalRequest): Promise<ApprovalRequest> {
    const now = new Date();
    const timeoutMs = request.timeoutMs ?? 86400000;
    const orgId = resolveCreateOrgId(request);

    const approval: ApprovalRequest = {
      id: ulid(),
      orgId,
      correlationId: request.correlationId,
      workflowId: request.workflowId,
      workflowName: request.workflowName,
      executionId: request.executionId,
      nodeId: request.nodeId,
      trigger: request.trigger,
      approvers: request.approvers,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
      metadata: request.metadata,
    };

    await this.pool.query(
      `INSERT INTO approvals (
        id, org_id, correlation_id, workflow_id, workflow_name, execution_id, node_id,
        trigger, approvers, status, created_at, expires_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        approval.id,
        orgId,
        approval.correlationId,
        approval.workflowId,
        approval.workflowName,
        approval.executionId,
        approval.nodeId,
        JSON.stringify(approval.trigger),
        JSON.stringify(approval.approvers),
        approval.status,
        approval.createdAt,
        approval.expiresAt,
        approval.metadata ? JSON.stringify(approval.metadata) : null,
      ]
    );

    return approval;
  }

  async get(id: string, scope: ApprovalOrgScope): Promise<ApprovalRequest | null> {
    const params: unknown[] = [id];
    let query = 'SELECT * FROM approvals WHERE id = $1';
    if (scope !== SYSTEM_SCOPE) {
      query += ' AND org_id = $2';
      params.push(scope);
    }
    const result = await this.pool.query(query, params);

    if (result.rows.length === 0) return null;
    return this.rowToApproval(result.rows[0]);
  }

  async getByCorrelationId(correlationId: string, scope: ApprovalOrgScope): Promise<ApprovalRequest | null> {
    const params: unknown[] = [correlationId];
    let query = 'SELECT * FROM approvals WHERE correlation_id = $1';
    if (scope !== SYSTEM_SCOPE) {
      query += ' AND org_id = $2';
      params.push(scope);
    }
    query += ' ORDER BY created_at DESC LIMIT 1';

    const result = await this.pool.query(query, params);

    if (result.rows.length === 0) return null;
    return this.rowToApproval(result.rows[0]);
  }

  async list(options: ApprovalListOptions = {}, scope: ApprovalOrgScope): Promise<ApprovalRequest[]> {
    let query = 'SELECT * FROM approvals WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (scope !== SYSTEM_SCOPE) {
      query += ` AND org_id = $${paramIndex++}`;
      params.push(scope);
    }

    if (options.status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(options.status);
    }

    if (options.workflowId) {
      query += ` AND workflow_id = $${paramIndex++}`;
      params.push(options.workflowId);
    }

    if (options.correlationId) {
      query += ` AND correlation_id = $${paramIndex++}`;
      params.push(options.correlationId);
    }

    if (options.approver) {
      query += ` AND approvers ? $${paramIndex++}`;
      params.push(options.approver);
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
    return result.rows.map(row => this.rowToApproval(row));
  }

  async count(options: Omit<ApprovalListOptions, 'limit' | 'offset'> = {}, scope: ApprovalOrgScope): Promise<number> {
    let query = 'SELECT COUNT(*) FROM approvals WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (scope !== SYSTEM_SCOPE) {
      query += ` AND org_id = $${paramIndex++}`;
      params.push(scope);
    }

    if (options.status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(options.status);
    }

    if (options.workflowId) {
      query += ` AND workflow_id = $${paramIndex++}`;
      params.push(options.workflowId);
    }

    if (options.correlationId) {
      query += ` AND correlation_id = $${paramIndex++}`;
      params.push(options.correlationId);
    }

    if (options.approver) {
      query += ` AND approvers ? $${paramIndex++}`;
      params.push(options.approver);
    }

    const result = await this.pool.query(query, params);
    return parseInt(result.rows[0].count, 10);
  }

  async resolve(id: string, response: ApprovalResponse, scope: ApprovalOrgScope): Promise<ApprovalRequest> {
    const params: unknown[] = [
      id,
      response.decision,
      response.approver,
      response.timestamp,
      JSON.stringify({
        decision: response.decision,
        comment: response.comment,
        metadata: response.metadata,
      }),
    ];
    let query = `UPDATE approvals SET
        status = $2,
        resolved_by = $3,
        resolved_at = $4,
        resolution = $5
      WHERE id = $1 AND status = 'pending'`;
    if (scope !== SYSTEM_SCOPE) {
      query += ` AND org_id = $${params.length + 1}`;
      params.push(scope);
    }
    query += ' RETURNING *';

    const result = await this.pool.query(query, params);

    if (result.rows.length === 0) {
      // Same generic error for missing/not-pending/cross-org — never leaks
      // which reason applied (QF-MT WP6: hides row existence across orgs).
      throw new Error(`Approval not found or not pending: ${id}`);
    }

    return this.rowToApproval(result.rows[0]);
  }

  async resolveMulti(id: string, response: ApprovalResponse, updatedMetadata: Record<string, unknown>): Promise<ApprovalRequest> {
    // Uses pg_advisory_xact_lock to prevent double-completion under concurrent POST resumes.
    // The lock key is derived from the approval ID (first 8 hex chars of ULID → bigint).
    const lockKey = parseInt(id.slice(0, 8), 36);
    const result = await this.pool.query(
      `SELECT pg_advisory_xact_lock($1::bigint);
       UPDATE approvals SET
         status = $2,
         resolved_by = $3,
         resolved_at = $4,
         resolution = $5,
         metadata = $6
       WHERE id = $7 AND status = 'pending'
       RETURNING *`,
      [
        lockKey,
        response.decision,
        response.approver,
        response.timestamp,
        JSON.stringify({
          decision: response.decision,
          comment: response.comment,
          metadata: response.metadata,
        }),
        JSON.stringify(updatedMetadata),
        id,
      ]
    );

    if (result.rows.length === 0) {
      throw new Error(`Approval not found or not pending: ${id}`);
    }

    return this.rowToApproval(result.rows[0]);
  }

  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<ApprovalRequest> {
    const result = await this.pool.query(
      `UPDATE approvals SET metadata = $2 WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(metadata)]
    );

    if (result.rows.length === 0) {
      throw new Error(`Approval not found: ${id}`);
    }

    return this.rowToApproval(result.rows[0]);
  }

  /**
   * Atomically record a multi-stakeholder decision using a Postgres advisory
   * transaction lock (pg_advisory_xact_lock) to prevent concurrent race.
   * The entire read-check-write executes inside a single transaction.
   */
  async recordMultiDecision(
    id: string,
    approver: string,
    decision: 'approved' | 'denied',
    comment?: string
  ): Promise<ApprovalRequest> {
    const lockKey = parseInt(id.slice(0, 8), 36);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey]);

      // Read current state inside the lock
      const current = await client.query('SELECT * FROM approvals WHERE id = $1', [id]);
      if (current.rows.length === 0) throw new Error(`Approval not found: ${id}`);
      const row = current.rows[0];

      if (row.status !== 'pending') {
        await client.query('COMMIT');
        return this.rowToApproval(row);
      }

      const meta: Record<string, unknown> = row.metadata ?? {};
      const threshold: number = (meta.threshold as number) ?? 1;
      const existing: Array<{ approver: string; decision: string }> = (meta.decisions as Array<{ approver: string; decision: string }>) ?? [];

      // Idempotent
      if (existing.some((d) => d.approver === approver)) {
        await client.query('COMMIT');
        return this.rowToApproval(row);
      }

      const decisions = [...existing, { approver, decision, timestamp: new Date().toISOString(), comment }];
      const approveCount = decisions.filter(d => d.decision === 'approved').length;
      const updatedMeta = { ...meta, decisions };

      let result: { rows: Record<string, unknown>[] };
      if (decision === 'denied' || approveCount >= threshold) {
        const finalDecision = decision === 'denied' ? 'denied' : 'approved';
        result = await client.query(
          `UPDATE approvals SET status=$2, resolved_by=$3, resolved_at=NOW(), metadata=$4, resolution=$5
           WHERE id=$1 AND status='pending' RETURNING *`,
          [id, finalDecision, approver, JSON.stringify(updatedMeta),
           JSON.stringify({ decision: finalDecision, comment })]
        );
      } else {
        result = await client.query(
          `UPDATE approvals SET metadata=$2 WHERE id=$1 RETURNING *`,
          [id, JSON.stringify(updatedMeta)]
        );
      }

      await client.query('COMMIT');
      return this.rowToApproval(result.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async cancel(id: string, scope: ApprovalOrgScope): Promise<ApprovalRequest> {
    const params: unknown[] = [id];
    let query = `UPDATE approvals SET
        status = 'cancelled',
        resolved_at = NOW()
      WHERE id = $1 AND status = 'pending'`;
    if (scope !== SYSTEM_SCOPE) {
      query += ` AND org_id = $${params.length + 1}`;
      params.push(scope);
    }
    query += ' RETURNING *';

    const result = await this.pool.query(query, params);

    if (result.rows.length === 0) {
      throw new Error(`Approval not found or not pending: ${id}`);
    }

    return this.rowToApproval(result.rows[0]);
  }

  async expireOld(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE approvals SET
        status = 'expired',
        resolved_at = NOW()
      WHERE status = 'pending' AND expires_at < NOW()`
    );

    return result.rowCount ?? 0;
  }

  async getPendingForApprover(approver: string, scope: ApprovalOrgScope): Promise<ApprovalRequest[]> {
    return this.list({ status: 'pending', approver }, scope);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private rowToApproval(row: Record<string, unknown>): ApprovalRequest {
    return ApprovalRequestSchema.parse({
      id: row.id,
      orgId: row.org_id,
      correlationId: row.correlation_id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      executionId: row.execution_id,
      nodeId: row.node_id,
      trigger: row.trigger,
      approvers: row.approvers,
      status: row.status,
      createdAt: (row.created_at as Date)?.toISOString(),
      expiresAt: (row.expires_at as Date)?.toISOString(),
      resolvedBy: row.resolved_by,
      resolvedAt: row.resolved_at ? (row.resolved_at as Date).toISOString() : undefined,
      resolution: row.resolution,
      metadata: row.metadata,
    });
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createInMemoryApprovalStore(): ApprovalStore {
  return new InMemoryApprovalStore();
}

export function createPostgresApprovalStore(config: { connectionString: string }): ApprovalStore {
  return new PostgresApprovalStore(config);
}
