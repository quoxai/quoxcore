/**
 * 'budgets.*' endpoints — WP3.2 (docs/STREAM_CLI_PARITY_PLAN.md §2.3 #7).
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * Backend: quoxflow (NOT the auth service, NOT proxied by collector) —
 * quoxflow/src/api/routes/budgets.ts, mounted at `/api/budgets` (see
 * quoxflow/src/api/app.ts). `service: 'quoxflow'` resolves via the
 * SERVICE_PORTS.quoxflow=3200 entry (see cli/lib/api/endpoints/triggers.js
 * header for the full access-path decision this fragment reuses).
 *
 * Org scoping is via `?org_id=` QUERY PARAM on GET (list/get/usage), NOT a
 * path segment — unlike triggers.ts, this route IS org-checked server-side:
 *   - list requires `org_id` (400 org_id_required if missing) and filters
 *     `budgetStore.listBudgets({ org_id })` — no cross-tenant leak.
 *   - get/usage: `org_id` is optional on the query, but if present is
 *     checked against the budget's own `org_id` (403 forbidden on mismatch).
 *     Omitting it entirely returns the budget regardless of owner org — the
 *     CLI always sends org_id here to stay on the safe/scoped path.
 *   - create: `org_id` required in the POST body.
 *   - update (PATCH): `org_id` required in the body, checked against the
 *     existing budget's org_id (403 on mismatch) before applying the patch.
 *   - delete: `org_id` required in the body, checked the same way.
 */

export const budgets = {
  'budgets.list': {
    method: 'GET',
    service: 'quoxflow',
    path: () => `/api/budgets`,
    tags: ['live-safe'],
  },
  'budgets.get': {
    method: 'GET',
    service: 'quoxflow',
    path: ({ id }) => `/api/budgets/${id}`,
    tags: ['live-safe'],
  },
  'budgets.create': {
    method: 'POST',
    service: 'quoxflow',
    path: () => `/api/budgets`,
    tags: ['live-write'],
  },
  'budgets.update': {
    method: 'PATCH',
    service: 'quoxflow',
    path: ({ id }) => `/api/budgets/${id}`,
    tags: ['live-write'],
  },
  'budgets.delete': {
    method: 'DELETE',
    service: 'quoxflow',
    path: ({ id }) => `/api/budgets/${id}`,
    tags: ['live-write'],
  },
  'budgets.usage': {
    method: 'GET',
    service: 'quoxflow',
    path: ({ id }) => `/api/budgets/${id}/usage`,
    tags: ['live-safe'],
  },
};
