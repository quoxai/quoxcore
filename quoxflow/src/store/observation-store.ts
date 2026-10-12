/**
 * Observation Store — STUDY-REV W2 (R2)
 *
 * Durable persistence for Observation records produced by agentic
 * loop iterations. Queryable by task_id, correlation_id, workflow_id,
 * scoped per org.
 *
 * Pattern mirrors EnvelopeStore: pg.Pool + in-memory fallback,
 * init() creates table with CREATE TABLE IF NOT EXISTS, ULID PKs.
 */

import pg from 'pg';
import { ulid } from 'ulid';
import { Observation } from '../pipeline/lifecycle-hooks.js';
import { SYSTEM_SCOPE, SystemScope } from '../api/middleware/org-scope.js';

const { Pool } = pg;

/** Org scope accepted by the query/count methods below — string org id, or
 * the explicit cross-org SYSTEM_SCOPE sentinel (QF-MT WP7 — org filtering
 * was previously applied "only when orgId was passed", so omitting it
 * entirely returned every org's observations). */
export type ObservationOrgScope = string | SystemScope;

export interface ObservationStoreConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface ObservationRecord {
  id: string;
  ts: string;
  orgId: string;
  taskId?: string;
  nodeId?: string;
  workflowId?: string;
  correlationId?: string;
  observation: Observation;
}

export interface ObservationQuery {
  taskId?: string;
  correlationId?: string;
  workflowId?: string;
  orgId?: string;
}

export class ObservationStore {
  private pool: pg.Pool | null = null;
  private inMemory: Map<string, ObservationRecord> = new Map();
  private useInMemory: boolean;

  constructor(config?: ObservationStoreConfig) {
    this.useInMemory = !config;
    if (config) {
      this.pool = new Pool(config);
    }
  }

  async init(): Promise<void> {
    if (this.useInMemory) return;

    const createTable = `
      CREATE TABLE IF NOT EXISTS observations (
        id VARCHAR(26) PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL,
        org_id VARCHAR(255) NOT NULL,
        task_id VARCHAR(255),
        node_id VARCHAR(255),
        workflow_id VARCHAR(255),
        correlation_id VARCHAR(255),
        obs_type VARCHAR(50) NOT NULL,
        summary TEXT NOT NULL,
        content_hash TEXT,
        content_ref TEXT,
        content_size_bytes BIGINT,
        metadata JSONB,
        image_media_type VARCHAR(50)
      );

      CREATE INDEX IF NOT EXISTS idx_observations_task_id ON observations(task_id);
      CREATE INDEX IF NOT EXISTS idx_observations_correlation_id ON observations(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_observations_workflow_id ON observations(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_observations_org_id ON observations(org_id);
    `;

    await this.pool!.query(createTable);
  }

  async append(input: Omit<ObservationRecord, 'id' | 'ts'>): Promise<ObservationRecord> {
    const id = ulid();
    const ts = new Date().toISOString();

    // Drop imageBase64 before persisting (too large for relational storage)
    const { imageBase64: _dropped, ...obsToStore } = input.observation;

    const record: ObservationRecord = {
      id,
      ts,
      ...input,
      observation: obsToStore,
    };

    if (this.useInMemory) {
      this.inMemory.set(id, record);
      return record;
    }

    const query = `
      INSERT INTO observations (
        id, ts, org_id, task_id, node_id, workflow_id, correlation_id,
        obs_type, summary, content_hash, content_ref, content_size_bytes,
        metadata, image_media_type
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `;

    await this.pool!.query(query, [
      id,
      ts,
      input.orgId,
      input.taskId ?? null,
      input.nodeId ?? null,
      input.workflowId ?? null,
      input.correlationId ?? null,
      obsToStore.type,
      obsToStore.summary,
      obsToStore.contentHash ?? null,
      obsToStore.contentRef ?? null,
      obsToStore.contentSizeBytes ?? null,
      obsToStore.metadata ? JSON.stringify(obsToStore.metadata) : null,
      obsToStore.imageMediaType ?? null,
    ]);

    return record;
  }

  async get(id: string): Promise<ObservationRecord | null> {
    if (this.useInMemory) {
      return this.inMemory.get(id) ?? null;
    }

    const result = await this.pool!.query(
      'SELECT * FROM observations WHERE id = $1',
      [id]
    );

    return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
  }

  async queryByTask(taskId: string, scope: ObservationOrgScope): Promise<ObservationRecord[]> {
    if (this.useInMemory) {
      return Array.from(this.inMemory.values())
        .filter(r => r.taskId === taskId)
        .filter(r => scope === SYSTEM_SCOPE || r.orgId === scope)
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    }

    const conditions: string[] = ['task_id = $1'];
    const params: unknown[] = [taskId];
    if (scope !== SYSTEM_SCOPE) {
      conditions.push(`org_id = $${params.length + 1}`);
      params.push(scope);
    }

    const result = await this.pool!.query(
      `SELECT * FROM observations WHERE ${conditions.join(' AND ')} ORDER BY ts ASC`,
      params
    );

    return result.rows.map(row => this.rowToRecord(row));
  }

  async queryByCorrelation(correlationId: string, scope: ObservationOrgScope): Promise<ObservationRecord[]> {
    if (this.useInMemory) {
      return Array.from(this.inMemory.values())
        .filter(r => r.correlationId === correlationId)
        .filter(r => scope === SYSTEM_SCOPE || r.orgId === scope)
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    }

    const conditions: string[] = ['correlation_id = $1'];
    const params: unknown[] = [correlationId];
    if (scope !== SYSTEM_SCOPE) {
      conditions.push(`org_id = $${params.length + 1}`);
      params.push(scope);
    }

    const result = await this.pool!.query(
      `SELECT * FROM observations WHERE ${conditions.join(' AND ')} ORDER BY ts ASC`,
      params
    );

    return result.rows.map(row => this.rowToRecord(row));
  }

  async queryByWorkflow(
    workflowId: string,
    scope: ObservationOrgScope,
    opts?: { limit?: number }
  ): Promise<ObservationRecord[]> {
    if (this.useInMemory) {
      let results = Array.from(this.inMemory.values())
        .filter(r => r.workflowId === workflowId)
        .filter(r => scope === SYSTEM_SCOPE || r.orgId === scope)
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

      if (opts?.limit) {
        results = results.slice(0, opts.limit);
      }

      return results;
    }

    const conditions: string[] = ['workflow_id = $1'];
    const params: unknown[] = [workflowId];
    let paramIndex = 2;

    if (scope !== SYSTEM_SCOPE) {
      conditions.push(`org_id = $${paramIndex++}`);
      params.push(scope);
    }

    let query = `SELECT * FROM observations WHERE ${conditions.join(' AND ')} ORDER BY ts ASC`;

    if (opts?.limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(opts.limit);
    }

    const result = await this.pool!.query(query, params);
    return result.rows.map(row => this.rowToRecord(row));
  }

  async count(
    scope: ObservationOrgScope,
    filters: { taskId?: string; correlationId?: string; workflowId?: string } = {}
  ): Promise<number> {
    if (this.useInMemory) {
      let results = Array.from(this.inMemory.values());

      if (filters.taskId) results = results.filter(r => r.taskId === filters.taskId);
      if (filters.correlationId) results = results.filter(r => r.correlationId === filters.correlationId);
      if (filters.workflowId) results = results.filter(r => r.workflowId === filters.workflowId);
      if (scope !== SYSTEM_SCOPE) results = results.filter(r => r.orgId === scope);

      return results.length;
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.taskId) {
      conditions.push(`task_id = $${paramIndex++}`);
      params.push(filters.taskId);
    }
    if (filters.correlationId) {
      conditions.push(`correlation_id = $${paramIndex++}`);
      params.push(filters.correlationId);
    }
    if (filters.workflowId) {
      conditions.push(`workflow_id = $${paramIndex++}`);
      params.push(filters.workflowId);
    }
    if (scope !== SYSTEM_SCOPE) {
      conditions.push(`org_id = $${paramIndex++}`);
      params.push(scope);
    }

    let query = 'SELECT COUNT(*) FROM observations';
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    const result = await this.pool!.query(query, params);
    return parseInt(result.rows[0].count, 10);
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  private rowToRecord(row: Record<string, unknown>): ObservationRecord {
    const observation: Observation = {
      type: row.obs_type as Observation['type'],
      summary: row.summary as string,
    };

    if (row.content_hash != null) observation.contentHash = row.content_hash as string;
    if (row.content_ref != null) observation.contentRef = row.content_ref as string;
    if (row.content_size_bytes != null) observation.contentSizeBytes = Number(row.content_size_bytes);
    if (row.metadata != null) observation.metadata = row.metadata as Record<string, unknown>;
    if (row.image_media_type != null) observation.imageMediaType = row.image_media_type as string;

    const record: ObservationRecord = {
      id: row.id as string,
      ts: (row.ts as Date).toISOString(),
      orgId: row.org_id as string,
      observation,
    };

    if (row.task_id != null) record.taskId = row.task_id as string;
    if (row.node_id != null) record.nodeId = row.node_id as string;
    if (row.workflow_id != null) record.workflowId = row.workflow_id as string;
    if (row.correlation_id != null) record.correlationId = row.correlation_id as string;

    return record;
  }
}

export function createInMemoryObservationStore(): ObservationStore {
  return new ObservationStore();
}

export function createPostgresObservationStore(config: ObservationStoreConfig): ObservationStore {
  return new ObservationStore(config);
}
