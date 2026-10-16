/**
 * Budget Usage Ingestion Route — STUDY-REV-2 P8.B.2
 *
 * Route:
 *   POST /api/v1/budget/usage
 *
 * Accepts a usage event, resolves the matching active budget for the given
 * scope, computes cost_usd_micro server-side from the model pricing map,
 * records the usage, and returns updated rolling totals.
 *
 * When no budget exists for the scope, returns zero totals silently (no error).
 * This keeps fire-and-forget callers safe — they don't need to know if a
 * budget was configured.
 */

import { Hono, Context } from 'hono';
import { AppEnv } from '../types.js';
import { BudgetStore, BudgetScopeKind } from '../../budget/budget-store.js';
import { computeCostUsdMicro } from '../../budget/model-pricing.js';
import { requireCallerOrg } from '../middleware/org-scope.js';

// ─── Config ───────────────────────────────────────────────────────────────────

interface BudgetUsageRoutesConfig {
  budgetStore: BudgetStore;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorResp(c: Context<AppEnv>, status: number, code: string, message: string) {
  return c.json({ success: false, error: { code, message } }, status as any);
}

const ZERO_TOTALS = {
  totalTokens: 0,
  totalCostUsdMicro: 0,
  totalToolCalls: 0,
  totalDurationMs: 0,
  totalIterations: 0,
};

// ─── Route Factory ────────────────────────────────────────────────────────────

export function createBudgetUsageRoutes(config: BudgetUsageRoutesConfig) {
  const app = new Hono<AppEnv>();
  const { budgetStore } = config;

  /**
   * POST /api/v1/budget/usage
   *
   * Body:
   *   org_id        — required
   *   scope_kind    — 'org' | 'objective' | 'execution' | 'iteration'
   *   scope_id      — entity ID for the scope
   *   tokens_in     — input token count
   *   tokens_out    — output token count
   *   model         — model key ("provider/model")
   *   tool_calls    — number of tool calls in this round
   *   duration_ms   — wall-clock time for this round
   *   iteration_count — agentic iteration count (1 for non-agentic)
   *   source_kind   — 'execution' | 'iteration'
   *   source_id     — execution/task ID (for attribution)
   *
   * Response:
   *   { totalTokens, totalCostUsdMicro, totalToolCalls, totalDurationMs, totalIterations }
   */
  app.post('/usage', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return errorResp(c, 400, 'invalid_body', 'Request body must be JSON');
    }

    const {
      org_id: claimedOrg,
      scope_kind = 'org',
      scope_id,
      tokens_in = 0,
      tokens_out = 0,
      model = 'default/unknown',
      tool_calls = 0,
      duration_ms = 0,
      iteration_count = 1,
      source_kind = 'execution',
      source_id = '',
    } = body as Record<string, unknown>;

    const who = requireCallerOrg(c, claimedOrg);
    if (!('orgId' in who)) return errorResp(c, who.status, who.code, who.message);
    const org_id = who.orgId;

    const effectiveScopeId = (scope_id as string) || (org_id as string);

    // Compute cost server-side from pricing map
    const cost_usd_micro = computeCostUsdMicro(
      Number(tokens_in),
      Number(tokens_out),
      String(model)
    );

    // Find active budget for this org+scope — use the most specific match.
    // Try scope_kind match first, then fall back to org-level.
    const now = new Date().toISOString();

    let matchingBudgets = await budgetStore.listBudgets(org_id as string, {
      scope_kind: scope_kind as BudgetScopeKind,
      scope_id: effectiveScopeId,
      active_at: now,
    });

    // Fallback: if no exact scope match, try org-level budget
    if (matchingBudgets.length === 0 && scope_kind !== 'org') {
      matchingBudgets = await budgetStore.listBudgets(org_id as string, {
        scope_kind: 'org',
        scope_id: org_id as string,
        active_at: now,
      });
    }

    // No budget → return zero totals silently (fire-and-forget safety)
    if (matchingBudgets.length === 0) {
      return c.json({ success: true, data: ZERO_TOTALS }, 200);
    }

    // Record usage against first matching budget (most specific)
    const budget = matchingBudgets[0];

    await budgetStore.recordUsage({
      budget_id: budget.id,
      ts: now,
      tokens_in: Number(tokens_in),
      tokens_out: Number(tokens_out),
      model: String(model),
      cost_usd_micro,
      tool_calls: Number(tool_calls),
      duration_ms: Number(duration_ms),
      iteration_count: Number(iteration_count),
      source_kind: String(source_kind),
      source_id: String(source_id),
    });

    // Return updated rolling totals
    const rolled = await budgetStore.getRolledUpUsage(budget.id);

    return c.json({
      success: true,
      data: {
        totalTokens: rolled.tokens_in + rolled.tokens_out,
        totalCostUsdMicro: rolled.cost_usd_micro,
        totalToolCalls: rolled.tool_calls,
        totalDurationMs: rolled.duration_ms,
        totalIterations: rolled.iteration_count,
      },
    }, 200);
  });

  return app;
}
