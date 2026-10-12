/**
 * Policy Store
 *
 * Persistence layer for policy definitions.
 * Supports both PostgreSQL and in-memory storage.
 */

import { Pool } from 'pg';
import {
  PolicyDefinition,
  PolicyDefinitionSchema,
  PolicyStore,
  PolicyListOptions,
  PolicyOrgScope,
} from '../policy/types.js';
import { SYSTEM_SCOPE } from '../api/middleware/org-scope.js';

/** Sentinel org_id value legacy/system-authored rows fall to — mirrors the
 * `policies` table column's `DEFAULT 'default'` and the same convention used
 * by workflow-store.ts. A policy stamped with this value (or with no orgId
 * at all, in-memory) is legacy/global and stays visible to every org. */
const LEGACY_ORG_ID = 'default';

/**
 * True when a policy is visible under the given scope. SYSTEM_SCOPE sees
 * everything. A policy with no `orgId` stamped, or stamped with the legacy
 * `'default'` sentinel (legacy/global — see the PolicyOrgScope docstring in
 * policy/types.ts) is visible to every org, mirroring policies.ts's existing
 * route-level filter exactly. A policy with a real orgId is visible only to
 * that org.
 */
function orgMatches(policy: PolicyDefinition, scope: PolicyOrgScope): boolean {
  if (scope === SYSTEM_SCOPE) return true;
  const orgId = policy.orgId;
  if (!orgId || orgId === LEGACY_ORG_ID) return true;
  return orgId === scope;
}

/** Resolve the org_id value to persist for a write. Policies with no orgId
 * stamped (legacy/system writes) fall to the legacy sentinel — matching
 * workflow-store.ts's resolveWriteOrgId() convention. */
function resolveWriteOrgId(policy: PolicyDefinition): string {
  return policy.orgId ?? LEGACY_ORG_ID;
}

// ============================================================================
// In-Memory Policy Store
// ============================================================================

export class InMemoryPolicyStore implements PolicyStore {
  private policies: Map<string, PolicyDefinition> = new Map();

  async init(): Promise<void> {
    // No initialization needed for in-memory store
  }

  async save(policy: PolicyDefinition): Promise<PolicyDefinition | null> {
    const now = new Date().toISOString();
    const stored: PolicyDefinition = {
      ...policy,
      createdAt: policy.createdAt ?? now,
      updatedAt: now,
    };
    // Ownership guard (mirrors PostgresPolicyStore.save and the
    // workflow-store precedent): an upsert must never reassign an existing
    // policy across orgs — id-reuse by another tenant returns null.
    const existing = this.policies.get(policy.id);
    if (existing && resolveWriteOrgId(existing) !== resolveWriteOrgId(stored)) {
      return null;
    }
    this.policies.set(policy.id, stored);
    return stored;
  }

  async get(id: string, scope: PolicyOrgScope): Promise<PolicyDefinition | null> {
    const policy = this.policies.get(id) ?? null;
    if (!policy || !orgMatches(policy, scope)) return null;
    return policy;
  }

  async list(scope: PolicyOrgScope, options: PolicyListOptions = {}): Promise<PolicyDefinition[]> {
    let policies = Array.from(this.policies.values()).filter(p => orgMatches(p, scope));

    // Filter by enabled
    if (options.enabled !== undefined) {
      policies = policies.filter(p => p.enabled === options.enabled);
    }

    // Filter by workflow ID (check if workflow matches scope)
    if (options.workflowId) {
      policies = policies.filter(p => {
        if (!p.scope.workflows || p.scope.workflows.length === 0) return true;
        return p.scope.workflows.includes('*') || p.scope.workflows.includes(options.workflowId!);
      });
    }

    // Sort by priority (higher first), then by name
    policies.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.name.localeCompare(b.name);
    });

    // Pagination
    const offset = options.offset ?? 0;
    const limit = options.limit ?? policies.length;
    return policies.slice(offset, offset + limit);
  }

  async count(scope: PolicyOrgScope, options: Omit<PolicyListOptions, 'limit' | 'offset'> = {}): Promise<number> {
    const policies = await this.list(scope, options);
    return policies.length;
  }

  async update(id: string, updates: Partial<PolicyDefinition>): Promise<PolicyDefinition> {
    const existing = this.policies.get(id);
    if (!existing) {
      throw new Error(`Policy not found: ${id}`);
    }

    const updated: PolicyDefinition = {
      ...existing,
      ...updates,
      id: existing.id, // Prevent ID change
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.policies.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.policies.delete(id);
  }

  async getApplicable(workflowId: string, nodeType: string | undefined, scope: PolicyOrgScope): Promise<PolicyDefinition[]> {
    let policies = await this.list(scope, { enabled: true });

    policies = policies.filter(policy => {
      // Check workflow scope
      const workflowMatch =
        !policy.scope.workflows ||
        policy.scope.workflows.length === 0 ||
        policy.scope.workflows.includes('*') ||
        policy.scope.workflows.includes(workflowId);

      if (!workflowMatch) return false;

      // Check node type scope
      if (nodeType && policy.scope.nodeTypes && policy.scope.nodeTypes.length > 0) {
        return policy.scope.nodeTypes.includes('*') || policy.scope.nodeTypes.includes(nodeType);
      }

      return true;
    });

    return policies;
  }

  async close(): Promise<void> {
    // No cleanup needed
  }
}

// ============================================================================
// PostgreSQL Policy Store
// ============================================================================

export class PostgresPolicyStore implements PolicyStore {
  private pool: Pool;
  private initialized = false;

  constructor(config: { connectionString: string }) {
    this.pool = new Pool({ connectionString: config.connectionString });
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS policies (
        id VARCHAR(100) PRIMARY KEY,
        org_id VARCHAR(255) NOT NULL DEFAULT 'default',
        name VARCHAR(255) NOT NULL,
        version VARCHAR(50) DEFAULT '1.0',
        description TEXT,
        scope JSONB NOT NULL DEFAULT '{}',
        rules JSONB NOT NULL DEFAULT '[]',
        enabled BOOLEAN DEFAULT true,
        priority INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        created_by VARCHAR(255)
      );

      CREATE INDEX IF NOT EXISTS idx_policies_org_id ON policies(org_id);
      CREATE INDEX IF NOT EXISTS idx_policies_enabled ON policies(enabled);
      CREATE INDEX IF NOT EXISTS idx_policies_priority ON policies(priority DESC);
    `);

    this.initialized = true;
  }

  async save(policy: PolicyDefinition): Promise<PolicyDefinition | null> {
    const now = new Date().toISOString();
    const stored: PolicyDefinition = {
      ...policy,
      createdAt: policy.createdAt ?? now,
      updatedAt: now,
    };
    const orgId = resolveWriteOrgId(stored);

    // org_id is intentionally NOT in the ON CONFLICT SET list and the update
    // is guarded by owner org (workflow-store precedent): an upsert must
    // never reassign an existing policy across orgs. Cross-org id reuse
    // filters the update to 0 rows — RETURNING empty — and the caller gets
    // null.
    const result = await this.pool.query(
      `INSERT INTO policies (id, org_id, name, version, description, scope, rules, enabled, priority, created_at, updated_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         version = EXCLUDED.version,
         description = EXCLUDED.description,
         scope = EXCLUDED.scope,
         rules = EXCLUDED.rules,
         enabled = EXCLUDED.enabled,
         priority = EXCLUDED.priority,
         updated_at = EXCLUDED.updated_at
       WHERE policies.org_id = EXCLUDED.org_id
       RETURNING id`,
      [
        stored.id,
        orgId,
        stored.name,
        stored.version,
        stored.description,
        JSON.stringify(stored.scope),
        JSON.stringify(stored.rules),
        stored.enabled,
        stored.priority,
        stored.createdAt,
        stored.updatedAt,
        stored.createdBy,
      ]
    );

    if (result.rows.length === 0) {
      // Conflicting row exists under a different org — write rejected.
      return null;
    }
    return stored;
  }

  async get(id: string, scope: PolicyOrgScope): Promise<PolicyDefinition | null> {
    const result = await this.pool.query(
      'SELECT * FROM policies WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) return null;
    const policy = this.rowToPolicy(result.rows[0]);
    if (!orgMatches(policy, scope)) return null;
    return policy;
  }

  async list(scope: PolicyOrgScope, options: PolicyListOptions = {}): Promise<PolicyDefinition[]> {
    let query = 'SELECT * FROM policies WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.enabled !== undefined) {
      query += ` AND enabled = $${paramIndex++}`;
      params.push(options.enabled);
    }

    if (options.workflowId) {
      query += ` AND (
        scope->'workflows' IS NULL OR
        scope->'workflows' = '[]'::jsonb OR
        scope->'workflows' ? '*' OR
        scope->'workflows' ? $${paramIndex++}
      )`;
      params.push(options.workflowId);
    }

    query += ' ORDER BY priority DESC, name ASC';

    if (options.limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options.offset) {
      query += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const result = await this.pool.query(query, params);
    // Scope filter (QF-MT WP7) applied in JS rather than SQL, mirroring
    // InMemoryPolicyStore.list() exactly: legacy/global rows (no orgId, or
    // the 'default' sentinel) pass orgMatches() for every scope, so they
    // stay visible to every org — only rows stamped with a *different* real
    // orgId are excluded.
    return result.rows.map(row => this.rowToPolicy(row)).filter(p => orgMatches(p, scope));
  }

  async count(scope: PolicyOrgScope, options: Omit<PolicyListOptions, 'limit' | 'offset'> = {}): Promise<number> {
    // Delegate to list() so the scope filter stays consistent between list and count.
    const policies = await this.list(scope, options);
    return policies.length;
  }

  async update(id: string, updates: Partial<PolicyDefinition>): Promise<PolicyDefinition> {
    const existing = await this.get(id, SYSTEM_SCOPE);
    if (!existing) {
      throw new Error(`Policy not found: ${id}`);
    }

    const updated: PolicyDefinition = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    await this.save(updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM policies WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getApplicable(workflowId: string, nodeType: string | undefined, scope: PolicyOrgScope): Promise<PolicyDefinition[]> {
    let query = `
      SELECT * FROM policies
      WHERE enabled = true
      AND (
        scope->'workflows' IS NULL OR
        scope->'workflows' = '[]'::jsonb OR
        scope->'workflows' ? '*' OR
        scope->'workflows' ? $1
      )
    `;
    const params: unknown[] = [workflowId];

    // Cross-tenant guard: restrict to the caller's org unless SYSTEM_SCOPE —
    // but legacy/global rows (org_id = 'default', see LEGACY_ORG_ID) stay
    // permissive for every org, matching InMemoryPolicyStore's orgMatches()
    // and the route-level guard in policies.ts.
    if (scope !== SYSTEM_SCOPE) {
      params.push(scope);
      query += ` AND (org_id = $${params.length} OR org_id = '${LEGACY_ORG_ID}')`;
    }

    if (nodeType) {
      params.push(nodeType);
      query += `
        AND (
          scope->'nodeTypes' IS NULL OR
          scope->'nodeTypes' = '[]'::jsonb OR
          scope->'nodeTypes' ? '*' OR
          scope->'nodeTypes' ? $${params.length}
        )
      `;
    }

    query += ' ORDER BY priority DESC, name ASC';

    const result = await this.pool.query(query, params);
    return result.rows.map(row => this.rowToPolicy(row));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private rowToPolicy(row: Record<string, unknown>): PolicyDefinition {
    // Zod .optional() accepts undefined but not null. DB nullable columns
    // come back as null — convert to undefined so Zod parse succeeds.
    // The legacy sentinel ('default') is normalized back to undefined so
    // callers see the same "no orgId stamped = legacy/global" shape the
    // in-memory store and policies.ts routes already assume.
    const rowOrgId = row.org_id as string | undefined;
    return PolicyDefinitionSchema.parse({
      id: row.id,
      orgId: rowOrgId && rowOrgId !== LEGACY_ORG_ID ? rowOrgId : undefined,
      name: row.name,
      version: row.version ?? undefined,
      description: row.description ?? undefined,
      scope: row.scope,
      rules: row.rules,
      enabled: row.enabled,
      priority: row.priority,
      createdAt: (row.created_at as Date)?.toISOString(),
      updatedAt: (row.updated_at as Date)?.toISOString(),
      createdBy: (row.created_by ?? undefined) as string | undefined,
    });
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createInMemoryPolicyStore(): PolicyStore {
  return new InMemoryPolicyStore();
}

export function createPostgresPolicyStore(config: { connectionString: string }): PolicyStore {
  return new PostgresPolicyStore(config);
}
