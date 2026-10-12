/**
 * Budgets Route — STUDY-REV-2 P8.B.2
 *
 * CRUD for budget definitions + rolled-up usage history.
 *
 * Routes:
 *   POST   /api/budgets                         — create
 *   GET    /api/budgets?org_id=&scope=&scope_id= — list
 *   GET    /api/budgets/:id?org_id=              — fetch
 *   PATCH  /api/budgets/:id                      — update
 *   DELETE /api/budgets/:id                      — delete (org_id in body)
 *   GET    /api/budgets/:id/usage?org_id=        — rolled-up usage + daily breakdown
 *
 * All mutating operations require org_id and verify it matches the budget's
 * org_id to prevent cross-tenant access.
 */

import { Hono, Context } from 'hono';
import { AppEnv } from '../types.js';
import { BudgetStore, BudgetScopeKind } from '../../budget/budget-store.js';

// ─── Config ───────────────────────────────────────────────────────────────────

interface BudgetsRoutesConfig {
  budgetStore: BudgetStore;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function success(c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) {
  return c.json(
    {
      success: true,
      data,
      meta: {
        requestId: c.get('correlationId') || 'unknown',
        timestamp: new Date().toISOString(),
      },
    },
    status
  );
}

function errorResp(c: Context<AppEnv>, status: number, code: string, message: string) {
  return c.json(
    {
      success: false,
      error: { code, message },
    },
    status as any
  );
}

const VALID_SCOPE_KINDS: BudgetScopeKind[] = ['org', 'objective', 'execution', 'iteration'];

/**
 * QF-MT WP7: resolve the mandatory caller org for GET /:id and GET /:id/usage.
 * Previously these two routes only checked ownership `if (orgId)` was
 * supplied on the query string — omitting it entirely returned the budget
 * (and its full cost history) regardless of tenant. `?org_id=` stays for
 * back-compat, but a JWT-authenticated caller supplying a mismatched value
 * gets a loud 400 instead of being silently overridden (same pattern as
 * executions.ts's body-orgId fix). Service callers use X-Org-Id; dev/test
 * callers with no auth middleware fall back to the query param, now required.
 */
function resolveBudgetOrgId(c: Context<AppEnv>): { orgId: string } | { error: Response } {
  const orgIdParam = c.req.query('org_id');
  const user = c.get('user') as { type?: string; org_id?: string } | undefined;

  if (user?.type === 'access') {
    const jwtOrgId = user.org_id;
    if (!jwtOrgId) {
      return { error: errorResp(c, 401, 'missing_org', 'Missing org_id in JWT — cannot serve request') };
    }
    if (orgIdParam && orgIdParam !== jwtOrgId) {
      return {
        error: errorResp(
          c,
          400,
          'org_mismatch',
          'org_id query parameter does not match the authenticated org — omit it, the JWT org is authoritative'
        ),
      };
    }
    return { orgId: jwtOrgId };
  }

  if (user?.type === 'service') {
    const headerOrgId = c.req.header('X-Org-Id') || c.req.header('X-Org-ID');
    const orgId = headerOrgId || orgIdParam;
    if (!orgId) {
      return { error: errorResp(c, 400, 'org_id_required', 'org_id query parameter or X-Org-Id header is required') };
    }
    return { orgId };
  }

  // No auth middleware ran (dev/test only). Production always rejects.
  if (process.env.NODE_ENV === 'production') {
    return { error: errorResp(c, 401, 'auth_required', 'Authentication required — no JWT present') };
  }
  if (!orgIdParam) {
    return { error: errorResp(c, 400, 'org_id_required', 'org_id query parameter is required') };
  }
  return { orgId: orgIdParam };
}

// ─── Route Factory ────────────────────────────────────────────────────────────

export function createBudgetsRoutes(config: BudgetsRoutesConfig) {
  const app = new Hono<AppEnv>();
  const { budgetStore } = config;

  // ── POST /api/budgets ──────────────────────────────────────────────────────

  /**
   * Create a new budget.
   * Required: org_id, scope_kind, scope_id, period_start, period_end.
   * Optional: max_tokens, max_cost_usd_micro, max_tool_calls, max_duration_ms,
   *           max_iterations, hard_stop (default true).
   */
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return errorResp(c, 400, 'invalid_body', 'Request body must be JSON');
    }

    const {
      org_id,
      scope_kind,
      scope_id,
      period_start,
      period_end,
      max_tokens,
      max_cost_usd_micro,
      max_tool_calls,
      max_duration_ms,
      max_iterations,
      hard_stop,
    } = body as Record<string, unknown>;

    if (!org_id || typeof org_id !== 'string') {
      return errorResp(c, 400, 'org_id_required', 'org_id is required');
    }
    if (!scope_kind || !VALID_SCOPE_KINDS.includes(scope_kind as BudgetScopeKind)) {
      return errorResp(c, 400, 'invalid_scope_kind', `scope_kind must be one of: ${VALID_SCOPE_KINDS.join(', ')}`);
    }
    if (!scope_id || typeof scope_id !== 'string') {
      return errorResp(c, 400, 'scope_id_required', 'scope_id is required');
    }
    if (!period_start || typeof period_start !== 'string') {
      return errorResp(c, 400, 'period_start_required', 'period_start (ISO string) is required');
    }
    if (!period_end || typeof period_end !== 'string') {
      return errorResp(c, 400, 'period_end_required', 'period_end (ISO string) is required');
    }

    const budget = await budgetStore.createBudget({
      org_id: org_id as string,
      scope_kind: scope_kind as BudgetScopeKind,
      scope_id: scope_id as string,
      period_start: period_start as string,
      period_end: period_end as string,
      max_tokens: typeof max_tokens === 'number' ? max_tokens : null,
      max_cost_usd_micro: typeof max_cost_usd_micro === 'number' ? max_cost_usd_micro : null,
      max_tool_calls: typeof max_tool_calls === 'number' ? max_tool_calls : null,
      max_duration_ms: typeof max_duration_ms === 'number' ? max_duration_ms : null,
      max_iterations: typeof max_iterations === 'number' ? max_iterations : null,
      hard_stop: typeof hard_stop === 'boolean' ? hard_stop : true,
    });

    return success(c, { budget }, 201);
  });

  // ── GET /api/budgets ───────────────────────────────────────────────────────

  /**
   * List budgets. org_id is required. Optional filters: scope, scope_id.
   */
  app.get('/', async (c) => {
    const orgId = c.req.query('org_id');
    if (!orgId) {
      return errorResp(c, 400, 'org_id_required', 'org_id query parameter is required');
    }

    const scope = c.req.query('scope') as BudgetScopeKind | undefined;
    const scopeId = c.req.query('scope_id');

    const budgets = await budgetStore.listBudgets(orgId, {
      scope_kind: scope && VALID_SCOPE_KINDS.includes(scope) ? scope : undefined,
      scope_id: scopeId || undefined,
    });

    return success(c, { budgets });
  });

  // ── GET /api/budgets/:id ──────────────────────────────────────────────────

  /**
   * Fetch a single budget. org_id must match the budget's org_id.
   */
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const resolved = resolveBudgetOrgId(c);
    if ('error' in resolved) return resolved.error;
    const { orgId } = resolved;

    const budget = await budgetStore.getBudget(id);
    if (!budget) {
      return errorResp(c, 404, 'not_found', `Budget ${id} not found`);
    }

    if (budget.org_id !== orgId) {
      return errorResp(c, 403, 'forbidden', 'org_id does not match budget owner');
    }

    return success(c, { budget });
  });

  // ── PATCH /api/budgets/:id ────────────────────────────────────────────────

  /**
   * Update a budget. Body must include org_id; must match the budget's org_id.
   */
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return errorResp(c, 400, 'invalid_body', 'Request body must be JSON');
    }

    const { org_id, ...patch } = body as Record<string, unknown>;
    if (!org_id || typeof org_id !== 'string') {
      return errorResp(c, 400, 'org_id_required', 'org_id is required in request body');
    }

    const existing = await budgetStore.getBudget(id);
    if (!existing) {
      return errorResp(c, 404, 'not_found', `Budget ${id} not found`);
    }
    if (existing.org_id !== org_id) {
      return errorResp(c, 403, 'forbidden', 'org_id does not match budget owner');
    }

    const budget = await budgetStore.updateBudget(id, patch as any);
    return success(c, { budget });
  });

  // ── DELETE /api/budgets/:id ────────────────────────────────────────────────

  /**
   * Delete a budget. org_id must be in body and match the budget's org_id.
   */
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const orgId = (body as any)?.org_id;

    const existing = await budgetStore.getBudget(id);
    if (!existing) {
      return errorResp(c, 404, 'not_found', `Budget ${id} not found`);
    }
    if (!orgId || existing.org_id !== orgId) {
      return errorResp(c, 403, 'forbidden', 'org_id does not match budget owner');
    }

    await budgetStore.deleteBudget(id);
    return success(c, { deleted: true });
  });

  // ── GET /api/budgets/:id/usage ─────────────────────────────────────────────

  /**
   * Rolled-up usage for a budget, plus a daily breakdown.
   * Query params: org_id (required), since (ISO), until (ISO).
   * Groups usage records by day (YYYY-MM-DD) for the Costs tab.
   */
  app.get('/:id/usage', async (c) => {
    const id = c.req.param('id');
    const resolved = resolveBudgetOrgId(c);
    if ('error' in resolved) return resolved.error;
    const { orgId } = resolved;

    const budget = await budgetStore.getBudget(id);
    if (!budget) {
      return errorResp(c, 404, 'not_found', `Budget ${id} not found`);
    }
    if (budget.org_id !== orgId) {
      return errorResp(c, 403, 'forbidden', 'org_id does not match budget owner');
    }

    const rolled = await budgetStore.getRolledUpUsage(id);
    const allUsage = await budgetStore.listUsage(id, 10_000);

    // Filter by since/until if provided
    const since = c.req.query('since');
    const until = c.req.query('until');

    const filtered = allUsage.filter(r => {
      if (since && r.ts < since) return false;
      if (until && r.ts > until) return false;
      return true;
    });

    // Group by day (YYYY-MM-DD)
    const dayMap = new Map<string, { date: string; tokens_in: number; tokens_out: number; cost_usd_micro: number; tool_calls: number; duration_ms: number; iteration_count: number }>();
    for (const r of filtered) {
      const date = r.ts.slice(0, 10);
      const existing = dayMap.get(date) ?? {
        date,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd_micro: 0,
        tool_calls: 0,
        duration_ms: 0,
        iteration_count: 0,
      };
      existing.tokens_in += r.tokens_in;
      existing.tokens_out += r.tokens_out;
      existing.cost_usd_micro += r.cost_usd_micro;
      existing.tool_calls += r.tool_calls;
      existing.duration_ms += r.duration_ms;
      existing.iteration_count += r.iteration_count;
      dayMap.set(date, existing);
    }

    const daily = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    return success(c, {
      usage: {
        totalTokens: rolled.tokens_in + rolled.tokens_out,
        totalCostUsdMicro: rolled.cost_usd_micro,
        totalToolCalls: rolled.tool_calls,
        totalDurationMs: rolled.duration_ms,
        totalIterations: rolled.iteration_count,
        tokensIn: rolled.tokens_in,
        tokensOut: rolled.tokens_out,
      },
      daily,
    });
  });

  return app;
}
