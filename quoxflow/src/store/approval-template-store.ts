/**
 * Approval Template Store — STUDY-REV-2 P8.C.1
 *
 * Persistence layer for approval templates.
 * Supports both PostgreSQL and in-memory storage.
 */

import { ulid } from 'ulid';
import { Pool } from 'pg';
import {
  ApprovalTemplate,
  ApprovalTemplateSchema,
  ApprovalTemplateStore,
} from '../policy/types.js';

// ============================================================================
// In-Memory Approval Template Store
// ============================================================================

export class InMemoryApprovalTemplateStore implements ApprovalTemplateStore {
  private templates: Map<string, ApprovalTemplate> = new Map();

  async init(): Promise<void> {
    // No initialization needed for in-memory store
  }

  async create(
    template: Omit<ApprovalTemplate, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ApprovalTemplate> {
    const now = new Date().toISOString();
    const stored = ApprovalTemplateSchema.parse({
      ...template,
      id: ulid(),
      escalation_chain: template.escalation_chain ?? [],
      timeout_ms: template.timeout_ms ?? 86400000,
      multi_party_threshold: template.multi_party_threshold ?? 1,
      createdAt: now,
      updatedAt: now,
    });
    this.templates.set(stored.id, stored);
    return stored;
  }

  async get(id: string, orgId: string): Promise<ApprovalTemplate | null> {
    const tpl = this.templates.get(id);
    if (!tpl) return null;
    if (tpl.orgId !== orgId) return null; // cross-tenant guard
    return tpl;
  }

  async list(orgId: string): Promise<ApprovalTemplate[]> {
    return Array.from(this.templates.values())
      .filter(t => t.orgId === orgId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async update(
    id: string,
    orgId: string,
    updates: Partial<Omit<ApprovalTemplate, 'id' | 'orgId' | 'createdAt' | 'updatedAt'>>
  ): Promise<ApprovalTemplate> {
    const existing = this.templates.get(id);
    if (!existing) throw new Error(`Approval template not found: ${id}`);
    if (existing.orgId !== orgId) throw new Error(`Approval template not found: ${id}`); // cross-tenant

    const updated = ApprovalTemplateSchema.parse({
      ...existing,
      ...updates,
      id: existing.id,
      orgId: existing.orgId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    });

    this.templates.set(id, updated);
    return updated;
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    const existing = this.templates.get(id);
    if (!existing) return false;
    if (existing.orgId !== orgId) return false; // cross-tenant guard
    return this.templates.delete(id);
  }

  async close(): Promise<void> {
    // No cleanup needed
  }
}

// ============================================================================
// PostgreSQL Approval Template Store
// ============================================================================

export class PostgresApprovalTemplateStore implements ApprovalTemplateStore {
  private pool: Pool;
  private initialized = false;

  constructor(config: { connectionString: string }) {
    this.pool = new Pool({ connectionString: config.connectionString });
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS approval_templates (
        id VARCHAR(100) PRIMARY KEY,
        org_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        approvers JSONB NOT NULL DEFAULT '[]',
        escalation_chain JSONB NOT NULL DEFAULT '[]',
        timeout_ms BIGINT DEFAULT 86400000,
        multi_party_threshold INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_approval_templates_org_id ON approval_templates(org_id);
    `);

    this.initialized = true;
  }

  async create(
    template: Omit<ApprovalTemplate, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ApprovalTemplate> {
    const now = new Date().toISOString();
    const id = ulid();

    await this.pool.query(
      `INSERT INTO approval_templates (id, org_id, name, approvers, escalation_chain, timeout_ms, multi_party_threshold, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        template.orgId,
        template.name,
        JSON.stringify(template.approvers),
        JSON.stringify(template.escalation_chain ?? []),
        template.timeout_ms ?? 86400000,
        template.multi_party_threshold ?? 1,
        now,
        now,
      ]
    );

    return ApprovalTemplateSchema.parse({
      id,
      orgId: template.orgId,
      name: template.name,
      approvers: template.approvers,
      escalation_chain: template.escalation_chain ?? [],
      timeout_ms: template.timeout_ms ?? 86400000,
      multi_party_threshold: template.multi_party_threshold ?? 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  async get(id: string, orgId: string): Promise<ApprovalTemplate | null> {
    const result = await this.pool.query(
      'SELECT * FROM approval_templates WHERE id = $1 AND org_id = $2',
      [id, orgId]
    );
    if (result.rows.length === 0) return null;
    return this.rowToTemplate(result.rows[0]);
  }

  async list(orgId: string): Promise<ApprovalTemplate[]> {
    const result = await this.pool.query(
      'SELECT * FROM approval_templates WHERE org_id = $1 ORDER BY name ASC',
      [orgId]
    );
    return result.rows.map(row => this.rowToTemplate(row));
  }

  async update(
    id: string,
    orgId: string,
    updates: Partial<Omit<ApprovalTemplate, 'id' | 'orgId' | 'createdAt' | 'updatedAt'>>
  ): Promise<ApprovalTemplate> {
    const existing = await this.get(id, orgId);
    if (!existing) throw new Error(`Approval template not found: ${id}`);

    const now = new Date().toISOString();
    const merged: ApprovalTemplate = {
      ...existing,
      ...updates,
      id: existing.id,
      orgId: existing.orgId,
      createdAt: existing.createdAt,
      updatedAt: now,
    };

    await this.pool.query(
      `UPDATE approval_templates SET name = $1, approvers = $2, escalation_chain = $3, timeout_ms = $4, multi_party_threshold = $5, updated_at = $6
       WHERE id = $7 AND org_id = $8`,
      [
        merged.name,
        JSON.stringify(merged.approvers),
        JSON.stringify(merged.escalation_chain ?? []),
        merged.timeout_ms,
        merged.multi_party_threshold,
        now,
        id,
        orgId,
      ]
    );

    return merged;
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM approval_templates WHERE id = $1 AND org_id = $2',
      [id, orgId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private rowToTemplate(row: Record<string, unknown>): ApprovalTemplate {
    return ApprovalTemplateSchema.parse({
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      approvers: row.approvers,
      escalation_chain: row.escalation_chain,
      timeout_ms: Number(row.timeout_ms),
      multi_party_threshold: Number(row.multi_party_threshold),
      createdAt: (row.created_at as Date)?.toISOString(),
      updatedAt: (row.updated_at as Date)?.toISOString(),
    });
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createInMemoryApprovalTemplateStore(): ApprovalTemplateStore {
  return new InMemoryApprovalTemplateStore();
}

export function createPostgresApprovalTemplateStore(config: { connectionString: string }): ApprovalTemplateStore {
  return new PostgresApprovalTemplateStore(config);
}
