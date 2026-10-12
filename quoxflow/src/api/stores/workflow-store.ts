/**
 * Workflow Store
 *
 * Persistence layer for workflow definitions.
 * Supports both in-memory and PostgreSQL backends.
 *
 * QF-MT WP3: every read/write is org-scoped. `save/list/get/count/update/
 * setActive/delete` all take an org scope (`orgId: string | typeof
 * SYSTEM_SCOPE`) so cross-org access is a deliberate, compile-checked choice
 * rather than an absent-parameter accident (see
 * docs/STREAM_QUOXFLOW_MULTITENANCY_PLAN.md §4/§6).
 *
 * - Reads filter by the caller's org unless SYSTEM_SCOPE is passed explicitly.
 * - Writes persist the caller's org (SYSTEM_SCOPE writes fall to the legacy
 *   'default' sentinel — same visibility rule as unbackfilled legacy rows).
 * - get/update/setActive/delete return null/false on a cross-org id match —
 *   NEVER a thrown 403. Routes turn that into a 404 (hides row existence).
 * - Legacy rows (org_id = 'default', or undefined in the in-memory store) are
 *   visible to SYSTEM_SCOPE only — tenant scopes must not see them until the
 *   operator-driven backfill (scripts/backfill-org.ts) runs.
 */

import { Pool, PoolConfig } from 'pg';
import { Workflow } from '../../core/workflow.js';
import { SYSTEM_SCOPE, SystemScope } from '../middleware/org-scope.js';

/** Org scope accepted by every WorkflowStore method — string org id, or the
 * explicit cross-org SYSTEM_SCOPE sentinel (never an absent parameter). */
export type WorkflowOrgScope = string | SystemScope;

/** Sentinel org_id value legacy/system-authored rows fall to. Mirrors the
 * Postgres column's old `DEFAULT 'default'` — kept as the literal string so
 * legacy rows and SYSTEM_SCOPE-authored rows share one hidden-from-tenants
 * bucket (§5 of the plan). */
const LEGACY_ORG_ID = 'default';

export interface StoredWorkflow {
  id: string;
  /** Tenant owner of this workflow. Populated from org_id column in Postgres. */
  orgId?: string;
  name: string;
  description?: string;
  notes?: string;
  version: string;
  definition: Workflow;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowStoreConfig {
  connectionString?: string;
  poolConfig?: PoolConfig;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  active?: boolean;
}

/** QSKL-AP-1: agentId count options — count workflows tagged with metadata.agentId */
export interface CountOptions extends Omit<ListOptions, 'limit' | 'offset'> {
  agentId?: string;
}

export interface SaveOptions {
  /** Org that will own this row. Required — SYSTEM_SCOPE writes fall to the
   * legacy/hidden 'default' bucket (loud, greppable — see module docstring). */
  orgId: WorkflowOrgScope;
  createdBy?: string;
}

export interface WorkflowStore {
  init(): Promise<void>;
  /**
   * Returns null when a tenant scope tries to save an id already owned by a
   * different org (cross-org id-reuse rejected — never silently reassigns
   * ownership). SYSTEM_SCOPE may update any existing row but preserves that
   * row's existing org_id rather than stomping it.
   */
  save(workflow: Workflow, options: SaveOptions): Promise<StoredWorkflow | null>;
  get(id: string, scope: WorkflowOrgScope): Promise<StoredWorkflow | null>;
  list(scope: WorkflowOrgScope, options?: ListOptions): Promise<StoredWorkflow[]>;
  count(scope: WorkflowOrgScope, options?: CountOptions): Promise<number>;
  update(id: string, scope: WorkflowOrgScope, updates: Partial<Workflow>): Promise<StoredWorkflow | null>;
  setActive(id: string, scope: WorkflowOrgScope, active: boolean): Promise<StoredWorkflow | null>;
  delete(id: string, scope: WorkflowOrgScope): Promise<boolean>;
  close(): Promise<void>;
}

/** Resolve the org_id value to persist for a write. SYSTEM_SCOPE writes are
 * stamped with the legacy sentinel — visible to SYSTEM_SCOPE reads only. */
function resolveWriteOrgId(scope: WorkflowOrgScope): string {
  return scope === SYSTEM_SCOPE ? LEGACY_ORG_ID : scope;
}

/** True when a stored row's org matches the caller's scope. SYSTEM_SCOPE
 * matches everything (explicit cross-org). Tenant scopes never match legacy/
 * undefined rows (§5 — unbackfilled rows are hidden, not leaked). */
function orgMatches(rowOrgId: string | undefined, scope: WorkflowOrgScope): boolean {
  if (scope === SYSTEM_SCOPE) return true;
  if (rowOrgId === undefined || rowOrgId === LEGACY_ORG_ID) return false;
  return rowOrgId === scope;
}

/**
 * In-memory workflow store for testing
 */
export class InMemoryWorkflowStore implements WorkflowStore {
  private workflows = new Map<string, StoredWorkflow>();

  async init(): Promise<void> {
    // No initialization needed
  }

  async save(workflow: Workflow, options: SaveOptions): Promise<StoredWorkflow | null> {
    const now = new Date().toISOString();
    const existing = this.workflows.get(workflow.id);

    // Cross-org id reuse: a tenant scope saving an id already owned by a
    // different org is rejected outright — never silently reassigns
    // ownership (this is the write-side counterpart of the by-id 404 on
    // get/update/setActive/delete).
    if (existing && options.orgId !== SYSTEM_SCOPE && existing.orgId !== options.orgId) {
      return null;
    }

    // SYSTEM_SCOPE updates preserve the existing row's org — it must never
    // stomp a tenant-owned row to the legacy 'default' bucket. Only a brand
    // new row (no existing) falls to the legacy sentinel under SYSTEM_SCOPE.
    const orgId = options.orgId === SYSTEM_SCOPE
      ? (existing?.orgId ?? LEGACY_ORG_ID)
      : options.orgId;

    const stored: StoredWorkflow = {
      id: workflow.id,
      orgId,
      name: workflow.name,
      description: workflow.description,
      notes: workflow.notes,
      version: workflow.version || '1.0.0',
      definition: workflow,
      active: true,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      createdBy: options.createdBy || existing?.createdBy,
      metadata: workflow.metadata,
    };

    this.workflows.set(workflow.id, stored);
    return stored;
  }

  async get(id: string, scope: WorkflowOrgScope): Promise<StoredWorkflow | null> {
    const stored = this.workflows.get(id);
    if (!stored) return null;
    if (!orgMatches(stored.orgId, scope)) return null;
    return stored;
  }

  async list(scope: WorkflowOrgScope, options?: ListOptions): Promise<StoredWorkflow[]> {
    let workflows = Array.from(this.workflows.values()).filter(w => orgMatches(w.orgId, scope));

    if (options?.active !== undefined) {
      workflows = workflows.filter(w => w.active === options.active);
    }

    // Sort by updatedAt descending
    workflows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const offset = options?.offset || 0;
    const limit = options?.limit || 100;

    return workflows.slice(offset, offset + limit);
  }

  async count(scope: WorkflowOrgScope, options?: CountOptions): Promise<number> {
    let workflows = Array.from(this.workflows.values()).filter(w => orgMatches(w.orgId, scope));

    if (options?.active !== undefined) {
      workflows = workflows.filter(w => w.active === options.active);
    }
    // QSKL-AP-1: filter by metadata.agentId if supplied
    if (options?.agentId !== undefined) {
      workflows = workflows.filter(w => (w.metadata as any)?.agentId === options.agentId);
    }

    return workflows.length;
  }

  async update(id: string, scope: WorkflowOrgScope, updates: Partial<Workflow>): Promise<StoredWorkflow | null> {
    const existing = this.workflows.get(id);
    if (!existing || !orgMatches(existing.orgId, scope)) {
      return null;
    }

    const updatedDefinition = { ...existing.definition, ...updates };
    const stored: StoredWorkflow = {
      ...existing,
      name: updates.name || existing.name,
      description: updates.description ?? existing.description,
      notes: updates.notes ?? existing.notes,
      version: updates.version || existing.version,
      definition: updatedDefinition,
      updatedAt: new Date().toISOString(),
      metadata: updates.metadata ?? existing.metadata,
    };

    this.workflows.set(id, stored);
    return stored;
  }

  async setActive(id: string, scope: WorkflowOrgScope, active: boolean): Promise<StoredWorkflow | null> {
    const existing = this.workflows.get(id);
    if (!existing || !orgMatches(existing.orgId, scope)) {
      return null;
    }

    const updated: StoredWorkflow = {
      ...existing,
      active,
      updatedAt: new Date().toISOString(),
    };

    this.workflows.set(id, updated);
    return updated;
  }

  async delete(id: string, scope: WorkflowOrgScope): Promise<boolean> {
    const existing = this.workflows.get(id);
    if (!existing || !orgMatches(existing.orgId, scope)) {
      return false;
    }
    return this.workflows.delete(id);
  }

  async close(): Promise<void> {
    this.workflows.clear();
  }
}

/**
 * PostgreSQL workflow store
 */
export class PostgresWorkflowStore implements WorkflowStore {
  private pool: Pool;

  constructor(config: WorkflowStoreConfig) {
    this.pool = new Pool(
      config.connectionString
        ? { connectionString: config.connectionString }
        : config.poolConfig
    );
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS workflows (
        id VARCHAR(100) PRIMARY KEY,
        org_id VARCHAR(255) NOT NULL DEFAULT 'default',
        name VARCHAR(255) NOT NULL,
        description TEXT,
        notes TEXT,
        version VARCHAR(50) DEFAULT '1.0.0',
        definition JSONB NOT NULL,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        created_by VARCHAR(255),
        metadata JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_workflows_org_id ON workflows(org_id);
      CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);
      CREATE INDEX IF NOT EXISTS idx_workflows_active ON workflows(active);
      CREATE INDEX IF NOT EXISTS idx_workflows_created_at ON workflows(created_at);
    `);

    // Migration: add notes column for existing tables
    await this.pool.query(`
      ALTER TABLE workflows ADD COLUMN IF NOT EXISTS notes TEXT;
    `);
  }

  async save(workflow: Workflow, options: SaveOptions): Promise<StoredWorkflow | null> {
    const orgId = resolveWriteOrgId(options.orgId);

    // org_id is intentionally NOT in the ON CONFLICT SET list — an upsert
    // must never reassign ownership of an existing row. For SYSTEM_SCOPE
    // that means the existing row's org_id is simply left untouched
    // (preserved, never stomped to the legacy sentinel). For a tenant scope
    // the WHERE guard below additionally makes the update a no-op — RETURNING
    // yields 0 rows — when the existing row belongs to a different org, so
    // the caller gets null (same 404-hides-existence signal as get/update).
    let query = `
      INSERT INTO workflows (id, org_id, name, description, notes, version, definition, active, created_by, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        notes = EXCLUDED.notes,
        version = EXCLUDED.version,
        definition = EXCLUDED.definition,
        updated_at = NOW(),
        metadata = EXCLUDED.metadata
    `;
    if (options.orgId !== SYSTEM_SCOPE) {
      query += ' WHERE workflows.org_id = EXCLUDED.org_id';
    }
    query += ' RETURNING *';

    const result = await this.pool.query(
      query,
      [
        workflow.id,
        orgId,
        workflow.name,
        workflow.description,
        workflow.notes,
        workflow.version || '1.0.0',
        JSON.stringify(workflow),
        options.createdBy,
        workflow.metadata ? JSON.stringify(workflow.metadata) : null,
      ]
    );

    if (result.rows.length === 0) {
      // Conflicting row exists under a different org — tenant write rejected.
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  async get(id: string, scope: WorkflowOrgScope): Promise<StoredWorkflow | null> {
    const params: unknown[] = [id];
    let query = 'SELECT * FROM workflows WHERE id = $1';
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

  async list(scope: WorkflowOrgScope, options?: ListOptions): Promise<StoredWorkflow[]> {
    let query = 'SELECT * FROM workflows';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (scope !== SYSTEM_SCOPE) {
      conditions.push(`org_id = $${params.length + 1}`);
      params.push(scope);
    }

    if (options?.active !== undefined) {
      conditions.push(`active = $${params.length + 1}`);
      params.push(options.active);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY updated_at DESC';

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

  async count(scope: WorkflowOrgScope, options?: CountOptions): Promise<number> {
    let query = 'SELECT COUNT(*) FROM workflows';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (scope !== SYSTEM_SCOPE) {
      conditions.push(`org_id = $${params.length + 1}`);
      params.push(scope);
    }

    if (options?.active !== undefined) {
      conditions.push(`active = $${params.length + 1}`);
      params.push(options.active);
    }
    // QSKL-AP-1: filter by metadata.agentId via JSONB containment
    if (options?.agentId !== undefined) {
      conditions.push(`metadata @> $${params.length + 1}::jsonb`);
      params.push(JSON.stringify({ agentId: options.agentId }));
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    const result = await this.pool.query(query, params);
    return parseInt(result.rows[0].count, 10);
  }

  async update(id: string, scope: WorkflowOrgScope, updates: Partial<Workflow>): Promise<StoredWorkflow | null> {
    // First get the existing workflow — org-scoped, so a cross-org id is
    // indistinguishable from a missing one (returns null, never throws).
    const existing = await this.get(id, scope);
    if (!existing) {
      return null;
    }

    const updatedDefinition = { ...existing.definition, ...updates };

    const params: unknown[] = [
      id,
      updates.name,
      updates.description,
      updates.notes,
      updates.version,
      JSON.stringify(updatedDefinition),
      updates.metadata ? JSON.stringify(updates.metadata) : null,
    ];
    let query = `
      UPDATE workflows SET
        name = COALESCE($2, name),
        description = COALESCE($3, description),
        notes = COALESCE($4, notes),
        version = COALESCE($5, version),
        definition = $6,
        updated_at = NOW(),
        metadata = COALESCE($7, metadata)
      WHERE id = $1
    `;
    if (scope !== SYSTEM_SCOPE) {
      query += ` AND org_id = $${params.length + 1}`;
      params.push(scope);
    }
    query += ' RETURNING *';

    const result = await this.pool.query(query, params);
    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  async setActive(id: string, scope: WorkflowOrgScope, active: boolean): Promise<StoredWorkflow | null> {
    const params: unknown[] = [id, active];
    let query = 'UPDATE workflows SET active = $2, updated_at = NOW() WHERE id = $1';
    if (scope !== SYSTEM_SCOPE) {
      query += ` AND org_id = $${params.length + 1}`;
      params.push(scope);
    }
    query += ' RETURNING *';

    const result = await this.pool.query(query, params);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  async delete(id: string, scope: WorkflowOrgScope): Promise<boolean> {
    const params: unknown[] = [id];
    let query = 'DELETE FROM workflows WHERE id = $1';
    if (scope !== SYSTEM_SCOPE) {
      query += ' AND org_id = $2';
      params.push(scope);
    }

    const result = await this.pool.query(query, params);
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private mapRow(row: Record<string, unknown>): StoredWorkflow {
    return {
      id: row.id as string,
      orgId: row.org_id as string | undefined,
      name: row.name as string,
      description: row.description as string | undefined,
      notes: row.notes as string | undefined,
      version: row.version as string,
      definition: row.definition as Workflow,
      active: row.active as boolean,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
      createdBy: row.created_by as string | undefined,
      metadata: row.metadata as Record<string, unknown> | undefined,
    };
  }
}

export function createInMemoryWorkflowStore(): WorkflowStore {
  return new InMemoryWorkflowStore();
}

export function createWorkflowStore(config: WorkflowStoreConfig): WorkflowStore {
  if (config.connectionString || config.poolConfig) {
    return new PostgresWorkflowStore(config);
  }
  return new InMemoryWorkflowStore();
}
