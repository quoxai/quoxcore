/**
 * Execution History Store — STUDY-REV W2 (Crystalliser feed)
 *
 * Records workflow execution outcomes so the Crystalliser can analyse
 * recent history and decide whether a workflow is ready for promotion
 * to the Skill Library.
 *
 * Pattern mirrors EnvelopeStore: pg.Pool + in-memory fallback,
 * init() creates table with CREATE TABLE IF NOT EXISTS, ULID PKs.
 */

import pg from 'pg';
import { ulid } from 'ulid';
import { ExecutionRecord } from '../pipeline/crystalliser.js';

const { Pool } = pg;

export interface ExecutionHistoryStoreConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

interface StoredEntry {
  id: string;
  ts: Date;
  orgId: string;
  workflowId: string;
  record: ExecutionRecord;
  /** MEM-DECAY MD.3: lineage graph — PK `id` of the prior execution_history
   * row for this workflow, written by durable-hooks.ts's parent-pointer lookup. */
  parentExecutionId?: string | null;
  /** MEM-DECAY MD.3: what this run was trying to do — written on failure
   * alongside `lesson`, derived in durable-hooks.ts from the run's action log. */
  motivation?: string | null;
  /** MEM-DECAY MD.3: short natural-language takeaway written on failure by
   * src/pipeline/lineage-analyzer.ts, forward-fed into future runs of the
   * same workflow (see agentic.executor.ts's crystal-retrieval injection site). */
  lesson?: string | null;
}

export class ExecutionHistoryStore {
  private pool: pg.Pool | null = null;
  private inMemory: StoredEntry[] = [];
  private useInMemory: boolean;

  constructor(config?: ExecutionHistoryStoreConfig) {
    this.useInMemory = !config;
    if (config) {
      this.pool = new Pool(config);
    }
  }

  async init(): Promise<void> {
    if (this.useInMemory) return;

    const createTable = `
      CREATE TABLE IF NOT EXISTS execution_history (
        id VARCHAR(26) PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        org_id VARCHAR(255) NOT NULL,
        workflow_id VARCHAR(255) NOT NULL,
        exec_id VARCHAR(255) NOT NULL,
        success BOOLEAN NOT NULL,
        node_count INT,
        duration_ms BIGINT,
        action_log JSONB,
        node_types JSONB,
        parent_execution_id VARCHAR(26),
        motivation TEXT,
        lesson TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_exec_history_org_workflow_ts
        ON execution_history(org_id, workflow_id, ts);
    `;

    await this.pool!.query(createTable);
  }

  async record(input: { orgId: string; workflowId: string; record: ExecutionRecord }): Promise<void> {
    const id = ulid();
    const ts = new Date();

    if (this.useInMemory) {
      this.inMemory.push({
        id,
        ts,
        orgId: input.orgId,
        workflowId: input.workflowId,
        record: input.record,
      });
      return;
    }

    const query = `
      INSERT INTO execution_history (
        id, ts, org_id, workflow_id, exec_id, success, node_count,
        duration_ms, action_log, node_types
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;

    await this.pool!.query(query, [
      id,
      ts.toISOString(),
      input.orgId,
      input.workflowId,
      input.record.id,
      input.record.success,
      input.record.nodeCount ?? null,
      input.record.durationMs ?? null,
      input.record.actionLog ? JSON.stringify(input.record.actionLog) : null,
      input.record.nodeTypes ? JSON.stringify(input.record.nodeTypes) : null,
    ]);
  }

  async getRecent(opts: {
    orgId: string;
    workflowId: string;
    limit?: number;
    order?: 'asc' | 'desc';
  }): Promise<ExecutionRecord[]> {
    const limit = opts.limit ?? 10;
    const order = opts.order ?? 'asc';

    if (this.useInMemory) {
      let results = this.inMemory
        .filter(e => e.orgId === opts.orgId && e.workflowId === opts.workflowId);

      // Sort by insertion order (ts)
      results.sort((a, b) => a.ts.getTime() - b.ts.getTime());

      if (order === 'desc') {
        results = results.reverse();
      }

      return results.slice(0, limit).map(e => e.record);
    }

    const query = `
      SELECT exec_id, success, node_count, duration_ms, action_log, node_types
      FROM execution_history
      WHERE org_id = $1 AND workflow_id = $2
      ORDER BY ts ${order === 'desc' ? 'DESC' : 'ASC'}
      LIMIT $3
    `;

    const result = await this.pool!.query(query, [opts.orgId, opts.workflowId, limit]);
    return result.rows.map(row => this.rowToRecord(row));
  }

  /**
   * MEM-DECAY MD.3: PK `id` of the most recent execution_history row for this
   * workflow, excluding `excludeExecId` (the just-recorded current run) — the
   * lineage graph's parent pointer. Returns null when this is the workflow's
   * first recorded run (or the only prior rows belong to other orgs).
   */
  async getMostRecentId(opts: {
    orgId: string;
    workflowId: string;
    excludeExecId: string;
  }): Promise<string | null> {
    if (this.useInMemory) {
      const candidates = this.inMemory
        .filter(e =>
          e.orgId === opts.orgId &&
          e.workflowId === opts.workflowId &&
          e.record.id !== opts.excludeExecId,
        )
        .sort((a, b) => b.ts.getTime() - a.ts.getTime());
      return candidates[0]?.id ?? null;
    }

    const result = await this.pool!.query(
      `SELECT id FROM execution_history
       WHERE org_id = $1 AND workflow_id = $2 AND exec_id != $3
       ORDER BY ts DESC
       LIMIT 1`,
      [opts.orgId, opts.workflowId, opts.excludeExecId],
    );
    return result.rows[0]?.id ?? null;
  }

  /**
   * MEM-DECAY MD.3: write lineage fields (parent_execution_id / motivation /
   * lesson) onto the row identified by its `exec_id` (== ExecutionRecord.id,
   * generated by durable-hooks.ts before record() is called). UPDATE-only —
   * only the fields explicitly present in `fields` are touched; `undefined`
   * means "leave as-is", `null` means "clear the column".
   */
  async setLineage(
    execId: string,
    fields: { parentExecutionId?: string | null; motivation?: string | null; lesson?: string | null },
  ): Promise<void> {
    if (this.useInMemory) {
      const entry = this.inMemory.find(e => e.record.id === execId);
      if (!entry) return;
      if (fields.parentExecutionId !== undefined) entry.parentExecutionId = fields.parentExecutionId;
      if (fields.motivation !== undefined) entry.motivation = fields.motivation;
      if (fields.lesson !== undefined) entry.lesson = fields.lesson;
      return;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (fields.parentExecutionId !== undefined) { sets.push(`parent_execution_id = $${i++}`); values.push(fields.parentExecutionId); }
    if (fields.motivation !== undefined) { sets.push(`motivation = $${i++}`); values.push(fields.motivation); }
    if (fields.lesson !== undefined) { sets.push(`lesson = $${i++}`); values.push(fields.lesson); }
    if (sets.length === 0) return;

    values.push(execId);
    await this.pool!.query(
      `UPDATE execution_history SET ${sets.join(', ')} WHERE exec_id = $${i}`,
      values,
    );
  }

  /**
   * MEM-DECAY MD.3: the last N non-null lessons recorded for this workflow,
   * newest-first — the lineage graph's forward-feed. Consumed at
   * agentic.executor.ts's crystal-retrieval injection site so a workflow's
   * own prior failures inform its next run's think-prompt context.
   */
  async getRecentLessons(opts: {
    orgId: string;
    workflowId: string;
    limit?: number;
  }): Promise<string[]> {
    const limit = opts.limit ?? 3;

    if (this.useInMemory) {
      return this.inMemory
        .filter(e => e.orgId === opts.orgId && e.workflowId === opts.workflowId && !!e.lesson)
        .sort((a, b) => b.ts.getTime() - a.ts.getTime())
        .slice(0, limit)
        .map(e => e.lesson as string);
    }

    const result = await this.pool!.query(
      `SELECT lesson FROM execution_history
       WHERE org_id = $1 AND workflow_id = $2 AND lesson IS NOT NULL
       ORDER BY ts DESC
       LIMIT $3`,
      [opts.orgId, opts.workflowId, limit],
    );
    return result.rows.map(row => row.lesson as string);
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  private rowToRecord(row: Record<string, unknown>): ExecutionRecord {
    return {
      id: row.exec_id as string,
      success: row.success as boolean,
      nodeCount: row.node_count != null ? Number(row.node_count) : 0,
      durationMs: row.duration_ms != null ? Number(row.duration_ms) : 0,
      actionLog: (row.action_log as Array<{ action: string; params: Record<string, unknown> }>) ?? [],
      nodeTypes: (row.node_types as string[]) ?? [],
    };
  }
}

export function createInMemoryExecutionHistoryStore(): ExecutionHistoryStore {
  return new ExecutionHistoryStore();
}

export function createPostgresExecutionHistoryStore(config: ExecutionHistoryStoreConfig): ExecutionHistoryStore {
  return new ExecutionHistoryStore(config);
}
