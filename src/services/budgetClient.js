/**
 * budgetClient — STUDY-REV-2 P8.B.2
 *
 * Client for budget CRUD + usage endpoints, proxied through the collector.
 *
 * Proxy base: /collector/quoxflow/budgets
 *
 * All functions accept an optional orgId. If not passed, it is read from
 * localStorage('current_org_id') — same pattern as promptsClient / workflowEngine.
 * Tests pass orgId explicitly to avoid localStorage dependency.
 *
 * Functions:
 *   listBudgets    — GET /collector/quoxflow/budgets?org_id=…
 *   getBudget      — GET /collector/quoxflow/budgets/:id?org_id=…
 *   createBudget   — POST /collector/quoxflow/budgets (org_id in body)
 *   updateBudget   — PATCH /collector/quoxflow/budgets/:id (org_id in body)
 *   deleteBudget   — DELETE /collector/quoxflow/budgets/:id (org_id in body)
 *   getUsage       — GET /collector/quoxflow/budgets/:id/usage?org_id=…
 */

const PROXY_BASE = '/collector/quoxflow/budgets';

function readActiveOrgId() {
    try { return localStorage.getItem('current_org_id') || undefined; } catch { return undefined; }
}

function withOrg(orgId) {
    return orgId ?? readActiveOrgId();
}

function appendQs(base, params) {
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
}

async function handleResponse(resp) {
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body?.error?.message || body.error || body.message || `Request failed: HTTP ${resp.status}`);
    }
    return resp.json();
}

// ─── listBudgets ──────────────────────────────────────────────────────────────

/**
 * List budgets for an org.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch  — authenticated fetch (from useAuth)
 * @param {string}  [opts.orgId]     — org ID (defaults to localStorage current_org_id)
 * @param {string}  [opts.scope]     — scope_kind filter ('org'|'objective'|'execution'|'iteration')
 * @param {string}  [opts.scopeId]   — scope_id filter
 * @returns {Promise<Array>} budgets
 */
export async function listBudgets({ authFetch, orgId, scope, scopeId } = {}) {
    const org = withOrg(orgId);
    const params = new URLSearchParams();
    if (org) params.set('org_id', org);
    if (scope) params.set('scope', scope);
    if (scopeId) params.set('scope_id', scopeId);

    const json = await handleResponse(await authFetch(appendQs(PROXY_BASE, params)));
    return (json.data || json).budgets || [];
}

// ─── getBudget ────────────────────────────────────────────────────────────────

/**
 * Fetch a single budget by ID.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch
 * @param {string}  [opts.orgId]
 * @param {string}  opts.id          — budget ID
 * @returns {Promise<object>} budget
 */
export async function getBudget({ authFetch, orgId, id }) {
    const org = withOrg(orgId);
    const params = new URLSearchParams();
    if (org) params.set('org_id', org);

    const json = await handleResponse(await authFetch(appendQs(`${PROXY_BASE}/${encodeURIComponent(id)}`, params)));
    return (json.data || json).budget;
}

// ─── createBudget ─────────────────────────────────────────────────────────────

/**
 * Create a new budget.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch
 * @param {string}  [opts.orgId]
 * @param {string}  opts.scopeKind        — 'org'|'objective'|'execution'|'iteration'
 * @param {string}  opts.scopeId          — entity ID for the scope
 * @param {string}  opts.periodStart      — ISO string
 * @param {string}  opts.periodEnd        — ISO string
 * @param {number}  [opts.maxTokens]
 * @param {number}  [opts.maxCostUsdMicro]
 * @param {number}  [opts.maxToolCalls]
 * @param {number}  [opts.maxDurationMs]
 * @param {number}  [opts.maxIterations]
 * @param {boolean} [opts.hardStop]       — default true
 * @returns {Promise<object>} created budget
 */
export async function createBudget({
    authFetch,
    orgId,
    scopeKind,
    scopeId,
    periodStart,
    periodEnd,
    maxTokens,
    maxCostUsdMicro,
    maxToolCalls,
    maxDurationMs,
    maxIterations,
    hardStop = true,
} = {}) {
    const org = withOrg(orgId);
    const body = {
        org_id: org,
        scope_kind: scopeKind,
        scope_id: scopeId,
        period_start: periodStart,
        period_end: periodEnd,
        hard_stop: hardStop,
    };
    if (maxTokens != null) body.max_tokens = maxTokens;
    if (maxCostUsdMicro != null) body.max_cost_usd_micro = maxCostUsdMicro;
    if (maxToolCalls != null) body.max_tool_calls = maxToolCalls;
    if (maxDurationMs != null) body.max_duration_ms = maxDurationMs;
    if (maxIterations != null) body.max_iterations = maxIterations;

    const json = await handleResponse(await authFetch(PROXY_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }));
    return (json.data || json).budget;
}

// ─── updateBudget ─────────────────────────────────────────────────────────────

/**
 * Update budget fields.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch
 * @param {string}  [opts.orgId]
 * @param {string}  opts.id
 * @param {...any}  patch              — fields to update (camelCase → snake_case mapped)
 * @returns {Promise<object>} updated budget
 */
export async function updateBudget({ authFetch, orgId, id, maxTokens, maxCostUsdMicro, maxToolCalls, maxDurationMs, maxIterations, hardStop, periodStart, periodEnd } = {}) {
    const org = withOrg(orgId);
    const body = { org_id: org };
    if (maxTokens != null) body.max_tokens = maxTokens;
    if (maxCostUsdMicro != null) body.max_cost_usd_micro = maxCostUsdMicro;
    if (maxToolCalls != null) body.max_tool_calls = maxToolCalls;
    if (maxDurationMs != null) body.max_duration_ms = maxDurationMs;
    if (maxIterations != null) body.max_iterations = maxIterations;
    if (hardStop != null) body.hard_stop = hardStop;
    if (periodStart != null) body.period_start = periodStart;
    if (periodEnd != null) body.period_end = periodEnd;

    const json = await handleResponse(await authFetch(`${PROXY_BASE}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }));
    return (json.data || json).budget;
}

// ─── deleteBudget ─────────────────────────────────────────────────────────────

/**
 * Delete a budget.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch
 * @param {string}  [opts.orgId]
 * @param {string}  opts.id
 * @returns {Promise<{ deleted: boolean }>}
 */
export async function deleteBudget({ authFetch, orgId, id } = {}) {
    const org = withOrg(orgId);
    const json = await handleResponse(await authFetch(`${PROXY_BASE}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: org }),
    }));
    return (json.data || json);
}

// ─── getUsage ─────────────────────────────────────────────────────────────────

/**
 * Get rolled-up usage + daily breakdown for a budget.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch
 * @param {string}  [opts.orgId]
 * @param {string}  opts.id
 * @param {string}  [opts.since]    — ISO string, filter start
 * @param {string}  [opts.until]   — ISO string, filter end
 * @returns {Promise<{ usage: object, daily: Array }>}
 */
export async function getUsage({ authFetch, orgId, id, since, until } = {}) {
    const org = withOrg(orgId);
    const params = new URLSearchParams();
    if (org) params.set('org_id', org);
    if (since) params.set('since', since);
    if (until) params.set('until', until);

    const json = await handleResponse(await authFetch(appendQs(`${PROXY_BASE}/${encodeURIComponent(id)}/usage`, params)));
    return (json.data || json);
}
