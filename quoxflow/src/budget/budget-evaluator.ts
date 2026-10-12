/**
 * Budget Evaluator — STUDY-REV-2 P8.B
 *
 * Pure evaluation function: takes the store + context, returns allowed/denied.
 * No I/O beyond the store.
 *
 * Each active budget for the given scope is checked. Projected usage (what we're
 * about to spend) is added to the rolled-up historical usage, and compared against
 * each limit. If any limit is breached, the result is denied.
 *
 * Expired budgets (outside period_start..period_end) are ignored.
 *
 * R3.high-1: Concurrency guard.
 * When the store implements evaluateAndReserve(), that path is used — it wraps
 * the read + check + write inside a single atomic operation (mutex for InMemory,
 * SELECT FOR UPDATE transaction for Postgres). This prevents two concurrent
 * executions both reading current=0, both projecting 60, both passing a max=100
 * budget (double-spend).
 *
 * When evaluateAndReserve() is not available (legacy stores), the evaluator falls
 * back to the original read + check pattern (no concurrency guarantee).
 */

import { BudgetStore, BudgetScopeKind } from './budget-store.js';

export type ExceededReason = 'tokens' | 'cost' | 'tool_calls' | 'duration' | 'iterations';

export interface EvaluateOptions {
  scope: BudgetScopeKind;
  scopeId: string;
  orgId: string;
  projected: {
    tokens_in: number;
    tokens_out: number;
    cost_usd_micro: number;
    tool_calls: number;
    duration_ms: number;
    iterations: number;
  };
  /** Unique identifier for the caller — used as source_id on the reservation row. */
  sourceId?: string;
}

export interface EvaluateResult {
  allowed: boolean;
  reason?: string;
  exceeded?: ExceededReason[];
  /** ID of the reservation row when allowed via evaluateAndReserve. */
  reservationId?: string;
}

export class BudgetEvaluator {
  constructor(private readonly store: BudgetStore) {}

  /**
   * R5.med: Expose the underlying store so the pipeline can call
   * releaseReservation / finalizeReservation on execution outcome.
   */
  getStore(): BudgetStore {
    return this.store;
  }

  /**
   * Evaluate whether the projected usage is within budget for the given scope.
   * Returns { allowed: true } when no budgets are configured or all limits pass.
   *
   * Thread-safe when the store implements evaluateAndReserve() (InMemory uses a
   * per-budget mutex; Postgres uses SELECT FOR UPDATE).
   */
  async evaluate(options: EvaluateOptions): Promise<EvaluateResult> {
    const now = new Date().toISOString();

    // Find all active budgets for this scope.
    // QF-MT WP7: thread options.orgId through — previously this call omitted
    // org entirely, so a scope_kind+scope_id match from ANY org could satisfy
    // a budget check.
    const budgets = await this.store.listBudgets(options.orgId, {
      scope_kind: options.scope,
      scope_id: options.scopeId,
      active_at: now,
    });

    if (budgets.length === 0) {
      // No budget configured → allowed by default
      return { allowed: true };
    }

    const allExceeded: ExceededReason[] = [];
    let reservationId: string | undefined;

    for (const budget of budgets) {
      // R3.high-1: use atomic evaluate-and-reserve when the store supports it.
      if (this.store.evaluateAndReserve) {
        const atomicResult = await this.store.evaluateAndReserve(
          budget.id,
          options.projected,
          budget,
          options.sourceId ?? `eval-${Date.now()}`,
        );
        if (!atomicResult.allowed) {
          for (const r of (atomicResult.exceeded ?? [])) {
            if (!allExceeded.includes(r as ExceededReason)) {
              allExceeded.push(r as ExceededReason);
            }
          }
        } else {
          reservationId = atomicResult.reservationId;
        }
        continue;
      }

      // Legacy fallback: read + check (no concurrency guarantee)
      const current = await this.store.getRolledUpUsage(budget.id);
      const proj = options.projected;

      const projectedTokens = current.tokens_in + current.tokens_out + proj.tokens_in + proj.tokens_out;
      const projectedCost = current.cost_usd_micro + proj.cost_usd_micro;
      const projectedToolCalls = current.tool_calls + proj.tool_calls;
      const projectedDuration = current.duration_ms + proj.duration_ms;
      const projectedIterations = current.iteration_count + proj.iterations;

      if (budget.max_tokens != null && projectedTokens >= budget.max_tokens) {
        if (!allExceeded.includes('tokens')) allExceeded.push('tokens');
      }
      if (budget.max_cost_usd_micro != null && projectedCost >= budget.max_cost_usd_micro) {
        if (!allExceeded.includes('cost')) allExceeded.push('cost');
      }
      if (budget.max_tool_calls != null && projectedToolCalls >= budget.max_tool_calls) {
        if (!allExceeded.includes('tool_calls')) allExceeded.push('tool_calls');
      }
      if (budget.max_duration_ms != null && projectedDuration >= budget.max_duration_ms) {
        if (!allExceeded.includes('duration')) allExceeded.push('duration');
      }
      if (budget.max_iterations != null && projectedIterations >= budget.max_iterations) {
        if (!allExceeded.includes('iterations')) allExceeded.push('iterations');
      }
    }

    if (allExceeded.length > 0) {
      return {
        allowed: false,
        reason: `Budget exceeded: ${allExceeded.join(', ')}`,
        exceeded: allExceeded,
      };
    }

    return { allowed: true, reservationId };
  }
}
