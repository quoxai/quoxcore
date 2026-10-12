/**
 * Budget Store — STUDY-REV-2 P8.B
 *
 * Persistence layer for budget definitions and usage records.
 * Supports both PostgreSQL and in-memory storage.
 *
 * Units:
 *   - cost is stored as BIGINT micro-dollars (cost_usd_micro = round(cost_usd * 1e6))
 *     to avoid float drift across aggregations.
 *   - tokens stored as plain integers (in + out tracked separately for granularity)
 */

import { ulid } from 'ulid';
import pg from 'pg';
import { SYSTEM_SCOPE, SystemScope } from '../api/middleware/org-scope.js';

const { Pool } = pg;

/** Org scope accepted by BudgetStore.listBudgets — string org id, or the
 * explicit cross-org SYSTEM_SCOPE sentinel (never an absent parameter).
 * QF-MT WP7: closes the "org filter optional" gap — budget-evaluator.ts's
 * evaluate() previously called listBudgets() without threading its own
 * options.orgId through at all, so a scope_kind+scope_id match from ANY org
 * could satisfy a budget check. */
export type BudgetOrgScope = string | SystemScope;

// ─── Types ────────────────────────────────────────────────────────────────────

export type BudgetScopeKind = 'org' | 'objective' | 'execution' | 'iteration';

export interface Budget {
  id: string;
  scope_kind: BudgetScopeKind;
  scope_id: string;
  org_id: string;
  period_start: string;
  period_end: string;
  max_tokens: number | null;
  max_cost_usd_micro: number | null;
  max_tool_calls: number | null;
  max_duration_ms: number | null;
  max_iterations: number | null;
  hard_stop: boolean;
}

export type BudgetCreateInput = Omit<Budget, 'id'>;

export interface BudgetUsage {
  id: string;
  budget_id: string;
  ts: string;
  tokens_in: number;
  tokens_out: number;
  model: string;
  cost_usd_micro: number;
  tool_calls: number;
  duration_ms: number;
  iteration_count: number;
  source_kind: string;
  source_id: string;
}

export type BudgetUsageCreateInput = Omit<BudgetUsage, 'id'>;

export interface RolledUpUsage {
  tokens_in: number;
  tokens_out: number;
  cost_usd_micro: number;
  tool_calls: number;
  duration_ms: number;
  iteration_count: number;
}

export interface BudgetListOptions {
  scope_kind?: BudgetScopeKind;
  scope_id?: string;
  active_at?: string;  // ISO string — filter to budgets whose period covers this timestamp
}

// ─── Interface ────────────────────────────────────────────────────────────────

export interface EvaluateAndReserveResult {
  allowed: boolean;
  reservationId?: string;  // ID of the reserved usage row (to convert to final later)
  exceeded?: string[];
}

export interface BudgetStore {
  createBudget(input: BudgetCreateInput): Promise<Budget>;
  getBudget(id: string): Promise<Budget | null>;
  /**
   * QF-MT WP7: scope is a required first param — string org id, or explicit
   * SYSTEM_SCOPE for legitimate cross-org callers (never an absent/optional
   * org filter).
   */
  listBudgets(scope: BudgetOrgScope, options?: BudgetListOptions): Promise<Budget[]>;
  updateBudget(id: string, patch: Partial<Omit<Budget, 'id'>>): Promise<Budget>;
  deleteBudget(id: string): Promise<boolean>;
  recordUsage(input: BudgetUsageCreateInput): Promise<BudgetUsage>;
  getRolledUpUsage(budgetId: string): Promise<RolledUpUsage>;
  listUsage(budgetId: string, limit?: number): Promise<BudgetUsage[]>;
  /**
   * R3.high-1: Atomically evaluate budget and record a reservation if allowed.
   * For Postgres: uses SELECT ... FOR UPDATE to prevent concurrent double-spends.
   * For InMemory: uses a per-budget mutex lock chain.
   * Returns allowed=true + reservationId when budget permits the projected usage,
   * or allowed=false when the budget would be exceeded.
   */
  evaluateAndReserve?(
    budgetId: string,
    projected: { tokens_in: number; tokens_out: number; cost_usd_micro: number; tool_calls: number; duration_ms: number; iterations: number },
    budget: Budget,
    sourceId: string,
  ): Promise<EvaluateAndReserveResult>;
  /**
   * R5.med: Convert a reservation to a final usage record with actual cost.
   * Call on execution success. If reservationId is unknown, this is a no-op.
   */
  finalizeReservation?(reservationId: string, actualCost: { tokens_in: number; tokens_out: number; cost_usd_micro: number; tool_calls: number; duration_ms: number; iteration_count: number }): Promise<void>;
  /**
   * R5.med: Release a reservation, restoring budget capacity.
   * Call on execution failure or crash recovery.
   * If reservationId is unknown, this is a no-op.
   */
  releaseReservation?(reservationId: string): Promise<void>;
  /**
   * R5.med: Release all reservation rows older than the given age (for crash recovery at boot).
   * Returns the count of released reservations.
   */
  releaseStaleReservations?(olderThanMs: number): Promise<number>;
  close?(): Promise<void>;
}

// ─── In-Memory Implementation ─────────────────────────────────────────────────

export class InMemoryBudgetStore implements BudgetStore {
  private budgets: Map<string, Budget> = new Map();
  private usageRecords: Map<string, BudgetUsage> = new Map();
  // R3.high-1: per-budget mutex chain to prevent read-modify-write races.
  // Each budgetId maps to a promise chain. Concurrent callers wait for the
  // previous operation to complete before reading usage and recording reservations.
  private locks: Map<string, Promise<void>> = new Map();

  /** Acquire a per-budget exclusive lock and run fn inside it. */
  private withLock<T>(budgetId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(budgetId) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>((res) => { resolve = res; });
    this.locks.set(budgetId, next);
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        resolve();
        if (this.locks.get(budgetId) === next) this.locks.delete(budgetId);
      }
    });
  }

  async createBudget(input: BudgetCreateInput): Promise<Budget> {
    const budget: Budget = { id: ulid(), ...input };
    this.budgets.set(budget.id, budget);
    return budget;
  }

  async getBudget(id: string): Promise<Budget | null> {
    return this.budgets.get(id) ?? null;
  }

  async listBudgets(scope: BudgetOrgScope, options: BudgetListOptions = {}): Promise<Budget[]> {
    let budgets = Array.from(this.budgets.values());

    if (scope !== SYSTEM_SCOPE) {
      budgets = budgets.filter(b => b.org_id === scope);
    }
    if (options.scope_kind) {
      budgets = budgets.filter(b => b.scope_kind === options.scope_kind);
    }
    if (options.scope_id) {
      budgets = budgets.filter(b => b.scope_id === options.scope_id);
    }
    if (options.active_at) {
      const at = new Date(options.active_at).getTime();
      budgets = budgets.filter(b => {
        const start = new Date(b.period_start).getTime();
        const end = new Date(b.period_end).getTime();
        return at >= start && at < end;
      });
    }

    return budgets;
  }

  async updateBudget(id: string, patch: Partial<Omit<Budget, 'id'>>): Promise<Budget> {
    const existing = this.budgets.get(id);
    if (!existing) throw new Error(`Budget not found: ${id}`);
    const updated: Budget = { ...existing, ...patch, id };
    this.budgets.set(id, updated);
    return updated;
  }

  async deleteBudget(id: string): Promise<boolean> {
    return this.budgets.delete(id);
  }

  async recordUsage(input: BudgetUsageCreateInput): Promise<BudgetUsage> {
    const record: BudgetUsage = { id: ulid(), ...input };
    this.usageRecords.set(record.id, record);
    return record;
  }

  async getRolledUpUsage(budgetId: string): Promise<RolledUpUsage> {
    const records = Array.from(this.usageRecords.values()).filter(r => r.budget_id === budgetId);
    return records.reduce(
      (acc, r) => ({
        tokens_in: acc.tokens_in + r.tokens_in,
        tokens_out: acc.tokens_out + r.tokens_out,
        cost_usd_micro: acc.cost_usd_micro + r.cost_usd_micro,
        tool_calls: acc.tool_calls + r.tool_calls,
        duration_ms: acc.duration_ms + r.duration_ms,
        iteration_count: acc.iteration_count + r.iteration_count,
      }),
      { tokens_in: 0, tokens_out: 0, cost_usd_micro: 0, tool_calls: 0, duration_ms: 0, iteration_count: 0 }
    );
  }

  async listUsage(budgetId: string, limit = 100): Promise<BudgetUsage[]> {
    const records = Array.from(this.usageRecords.values())
      .filter(r => r.budget_id === budgetId)
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, limit);
    return records;
  }

  /**
   * R3.high-1: Atomically evaluate + reserve inside a per-budget mutex.
   * The lock prevents concurrent executions from both seeing current=0 and
   * both approving when the budget only has room for one.
   */
  async evaluateAndReserve(
    budgetId: string,
    projected: { tokens_in: number; tokens_out: number; cost_usd_micro: number; tool_calls: number; duration_ms: number; iterations: number },
    budget: Budget,
    sourceId: string,
  ): Promise<EvaluateAndReserveResult> {
    return this.withLock(budgetId, async () => {
      const current = await this.getRolledUpUsage(budgetId);

      const projectedTokens = current.tokens_in + current.tokens_out + projected.tokens_in + projected.tokens_out;
      const projectedCost = current.cost_usd_micro + projected.cost_usd_micro;
      const projectedToolCalls = current.tool_calls + projected.tool_calls;
      const projectedDuration = current.duration_ms + projected.duration_ms;
      const projectedIterations = current.iteration_count + projected.iterations;

      const exceeded: string[] = [];
      if (budget.max_tokens != null && projectedTokens >= budget.max_tokens) exceeded.push('tokens');
      if (budget.max_cost_usd_micro != null && projectedCost >= budget.max_cost_usd_micro) exceeded.push('cost');
      if (budget.max_tool_calls != null && projectedToolCalls >= budget.max_tool_calls) exceeded.push('tool_calls');
      if (budget.max_duration_ms != null && projectedDuration >= budget.max_duration_ms) exceeded.push('duration');
      if (budget.max_iterations != null && projectedIterations >= budget.max_iterations) exceeded.push('iterations');

      if (exceeded.length > 0) {
        return { allowed: false, exceeded };
      }

      // Record reservation immediately inside the lock so the next concurrent caller
      // sees the updated usage and cannot double-spend.
      const reservation = await this.recordUsage({
        budget_id: budgetId,
        ts: new Date().toISOString(),
        tokens_in: projected.tokens_in,
        tokens_out: projected.tokens_out,
        model: 'reservation',
        cost_usd_micro: projected.cost_usd_micro,
        tool_calls: projected.tool_calls,
        duration_ms: projected.duration_ms,
        iteration_count: projected.iterations,
        source_kind: 'reservation',
        source_id: sourceId,
      });

      return { allowed: true, reservationId: reservation.id };
    });
  }

  /**
   * R5.med: Convert a reservation row to a final usage row with actual cost.
   * Deletes the placeholder reservation and inserts the true usage.
   */
  async finalizeReservation(reservationId: string, actualCost: { tokens_in: number; tokens_out: number; cost_usd_micro: number; tool_calls: number; duration_ms: number; iteration_count: number }): Promise<void> {
    const reservation = this.usageRecords.get(reservationId);
    if (!reservation || reservation.source_kind !== 'reservation') return;

    // Replace the reservation row with the actual usage in-place.
    const finalised: BudgetUsage = {
      ...reservation,
      tokens_in: actualCost.tokens_in,
      tokens_out: actualCost.tokens_out,
      cost_usd_micro: actualCost.cost_usd_micro,
      tool_calls: actualCost.tool_calls,
      duration_ms: actualCost.duration_ms,
      iteration_count: actualCost.iteration_count,
      source_kind: 'actual',
    };
    this.usageRecords.set(reservationId, finalised);
  }

  /**
   * R5.med: Delete a reservation row, restoring budget capacity for that slot.
   */
  async releaseReservation(reservationId: string): Promise<void> {
    const reservation = this.usageRecords.get(reservationId);
    if (!reservation || reservation.source_kind !== 'reservation') return;
    this.usageRecords.delete(reservationId);
  }

  /**
   * R5.med: Release all reservation rows older than olderThanMs milliseconds.
   * Used at boot to clean up leaked reservations from crashed processes.
   */
  async releaseStaleReservations(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    let count = 0;
    for (const [id, record] of this.usageRecords) {
      if (record.source_kind === 'reservation' && record.ts < cutoff) {
        this.usageRecords.delete(id);
        count++;
      }
    }
    return count;
  }
}

// ─── PostgreSQL Implementation ────────────────────────────────────────────────

export class PostgresBudgetStore implements BudgetStore {
  private pool: pg.Pool;
  private initialized = false;

  constructor(config: { connectionString: string }) {
    this.pool = new Pool({ connectionString: config.connectionString });
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS budgets (
        id VARCHAR(26) PRIMARY KEY,
        scope_kind VARCHAR(20) NOT NULL,
        scope_id VARCHAR(255) NOT NULL,
        org_id VARCHAR(255) NOT NULL,
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL,
        max_tokens BIGINT,
        max_cost_usd_micro BIGINT,
        max_tool_calls BIGINT,
        max_duration_ms BIGINT,
        max_iterations BIGINT,
        hard_stop BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_budgets_org_id ON budgets(org_id);
      CREATE INDEX IF NOT EXISTS idx_budgets_scope ON budgets(scope_kind, scope_id);
      CREATE INDEX IF NOT EXISTS idx_budgets_period ON budgets(period_start, period_end);

      CREATE TABLE IF NOT EXISTS budget_usage (
        id VARCHAR(26) PRIMARY KEY,
        budget_id VARCHAR(26) NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
        ts TIMESTAMPTZ NOT NULL,
        tokens_in BIGINT NOT NULL DEFAULT 0,
        tokens_out BIGINT NOT NULL DEFAULT 0,
        model VARCHAR(255) NOT NULL DEFAULT '',
        cost_usd_micro BIGINT NOT NULL DEFAULT 0,
        tool_calls BIGINT NOT NULL DEFAULT 0,
        duration_ms BIGINT NOT NULL DEFAULT 0,
        iteration_count BIGINT NOT NULL DEFAULT 0,
        source_kind VARCHAR(50) NOT NULL DEFAULT '',
        source_id VARCHAR(255) NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_budget_usage_budget_id ON budget_usage(budget_id);
      CREATE INDEX IF NOT EXISTS idx_budget_usage_ts ON budget_usage(ts);
    `);

    this.initialized = true;
  }

  async createBudget(input: BudgetCreateInput): Promise<Budget> {
    await this.init();
    const id = ulid();
    await this.pool.query(
      `INSERT INTO budgets (id, scope_kind, scope_id, org_id, period_start, period_end, max_tokens, max_cost_usd_micro, max_tool_calls, max_duration_ms, max_iterations, hard_stop)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, input.scope_kind, input.scope_id, input.org_id, input.period_start, input.period_end,
       input.max_tokens, input.max_cost_usd_micro, input.max_tool_calls, input.max_duration_ms,
       input.max_iterations, input.hard_stop]
    );
    return { id, ...input };
  }

  async getBudget(id: string): Promise<Budget | null> {
    await this.init();
    const result = await this.pool.query('SELECT * FROM budgets WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;
    return this.rowToBudget(result.rows[0]);
  }

  async listBudgets(scope: BudgetOrgScope, options: BudgetListOptions = {}): Promise<Budget[]> {
    await this.init();
    let query = 'SELECT * FROM budgets WHERE 1=1';
    const params: unknown[] = [];
    let i = 1;

    if (scope !== SYSTEM_SCOPE) { query += ` AND org_id = $${i++}`; params.push(scope); }
    if (options.scope_kind) { query += ` AND scope_kind = $${i++}`; params.push(options.scope_kind); }
    if (options.scope_id) { query += ` AND scope_id = $${i++}`; params.push(options.scope_id); }
    if (options.active_at) {
      query += ` AND period_start <= $${i++} AND period_end > $${i++}`;
      params.push(options.active_at, options.active_at);
    }

    const result = await this.pool.query(query, params);
    return result.rows.map(r => this.rowToBudget(r));
  }

  async updateBudget(id: string, patch: Partial<Omit<Budget, 'id'>>): Promise<Budget> {
    await this.init();
    const existing = await this.getBudget(id);
    if (!existing) throw new Error(`Budget not found: ${id}`);
    const updated: Budget = { ...existing, ...patch, id };
    await this.pool.query(
      `UPDATE budgets SET scope_kind=$1, scope_id=$2, org_id=$3, period_start=$4, period_end=$5,
       max_tokens=$6, max_cost_usd_micro=$7, max_tool_calls=$8, max_duration_ms=$9, max_iterations=$10, hard_stop=$11
       WHERE id=$12`,
      [updated.scope_kind, updated.scope_id, updated.org_id, updated.period_start, updated.period_end,
       updated.max_tokens, updated.max_cost_usd_micro, updated.max_tool_calls, updated.max_duration_ms,
       updated.max_iterations, updated.hard_stop, id]
    );
    return updated;
  }

  async deleteBudget(id: string): Promise<boolean> {
    await this.init();
    const result = await this.pool.query('DELETE FROM budgets WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async recordUsage(input: BudgetUsageCreateInput): Promise<BudgetUsage> {
    await this.init();
    const id = ulid();
    await this.pool.query(
      `INSERT INTO budget_usage (id, budget_id, ts, tokens_in, tokens_out, model, cost_usd_micro, tool_calls, duration_ms, iteration_count, source_kind, source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, input.budget_id, input.ts, input.tokens_in, input.tokens_out, input.model,
       input.cost_usd_micro, input.tool_calls, input.duration_ms, input.iteration_count,
       input.source_kind, input.source_id]
    );
    return { id, ...input };
  }

  async getRolledUpUsage(budgetId: string): Promise<RolledUpUsage> {
    await this.init();
    const result = await this.pool.query(
      `SELECT
         COALESCE(SUM(tokens_in), 0) AS tokens_in,
         COALESCE(SUM(tokens_out), 0) AS tokens_out,
         COALESCE(SUM(cost_usd_micro), 0) AS cost_usd_micro,
         COALESCE(SUM(tool_calls), 0) AS tool_calls,
         COALESCE(SUM(duration_ms), 0) AS duration_ms,
         COALESCE(SUM(iteration_count), 0) AS iteration_count
       FROM budget_usage WHERE budget_id = $1`,
      [budgetId]
    );
    const row = result.rows[0];
    return {
      tokens_in: parseInt(row.tokens_in, 10),
      tokens_out: parseInt(row.tokens_out, 10),
      cost_usd_micro: parseInt(row.cost_usd_micro, 10),
      tool_calls: parseInt(row.tool_calls, 10),
      duration_ms: parseInt(row.duration_ms, 10),
      iteration_count: parseInt(row.iteration_count, 10),
    };
  }

  async listUsage(budgetId: string, limit = 100): Promise<BudgetUsage[]> {
    await this.init();
    const result = await this.pool.query(
      'SELECT * FROM budget_usage WHERE budget_id = $1 ORDER BY ts DESC LIMIT $2',
      [budgetId, limit]
    );
    return result.rows.map(r => ({
      id: r.id,
      budget_id: r.budget_id,
      ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts,
      tokens_in: parseInt(r.tokens_in, 10),
      tokens_out: parseInt(r.tokens_out, 10),
      model: r.model,
      cost_usd_micro: parseInt(r.cost_usd_micro, 10),
      tool_calls: parseInt(r.tool_calls, 10),
      duration_ms: parseInt(r.duration_ms, 10),
      iteration_count: parseInt(r.iteration_count, 10),
      source_kind: r.source_kind,
      source_id: r.source_id,
    }));
  }

  async finalizeReservation(reservationId: string, actualCost: { tokens_in: number; tokens_out: number; cost_usd_micro: number; tool_calls: number; duration_ms: number; iteration_count: number }): Promise<void> {
    await this.init();
    await this.pool.query(
      `UPDATE budget_usage
          SET tokens_in = $2, tokens_out = $3, cost_usd_micro = $4,
              tool_calls = $5, duration_ms = $6, iteration_count = $7,
              source_kind = 'actual'
        WHERE id = $1 AND source_kind = 'reservation'`,
      [reservationId, actualCost.tokens_in, actualCost.tokens_out, actualCost.cost_usd_micro,
       actualCost.tool_calls, actualCost.duration_ms, actualCost.iteration_count]
    );
  }

  async releaseReservation(reservationId: string): Promise<void> {
    await this.init();
    await this.pool.query(
      `DELETE FROM budget_usage WHERE id = $1 AND source_kind = 'reservation'`,
      [reservationId]
    );
  }

  async releaseStaleReservations(olderThanMs: number): Promise<number> {
    await this.init();
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.pool.query(
      `DELETE FROM budget_usage WHERE source_kind = 'reservation' AND ts < $1`,
      [cutoff]
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private rowToBudget(row: Record<string, unknown>): Budget {
    return {
      id: row.id as string,
      scope_kind: row.scope_kind as BudgetScopeKind,
      scope_id: row.scope_id as string,
      org_id: row.org_id as string,
      period_start: row.period_start instanceof Date ? row.period_start.toISOString() : row.period_start as string,
      period_end: row.period_end instanceof Date ? row.period_end.toISOString() : row.period_end as string,
      max_tokens: row.max_tokens != null ? parseInt(String(row.max_tokens), 10) : null,
      max_cost_usd_micro: row.max_cost_usd_micro != null ? parseInt(String(row.max_cost_usd_micro), 10) : null,
      max_tool_calls: row.max_tool_calls != null ? parseInt(String(row.max_tool_calls), 10) : null,
      max_duration_ms: row.max_duration_ms != null ? parseInt(String(row.max_duration_ms), 10) : null,
      max_iterations: row.max_iterations != null ? parseInt(String(row.max_iterations), 10) : null,
      hard_stop: row.hard_stop as boolean,
    };
  }
}

// ─── Factories ────────────────────────────────────────────────────────────────

export function createInMemoryBudgetStore(): BudgetStore {
  return new InMemoryBudgetStore();
}

export function createPostgresBudgetStore(config: { connectionString: string }): PostgresBudgetStore {
  return new PostgresBudgetStore(config);
}
