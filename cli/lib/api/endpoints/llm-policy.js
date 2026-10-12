/**
 * 'llm-policy.*' endpoints — WP3.2 (docs/STREAM_CLI_PARITY_PLAN.md §2.3 #7).
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * Backend: services/auth/routes/llm-routing-policies.js, mounted at plain
 * `/api` (server.js:546 — mounted BEFORE the requireAuth-router block on
 * purpose, per that file's own header comment, so it can carry a
 * service-key-gated /internal route; the three routes used here still apply
 * requireAuth + requireOrgMembership per-route). Real paths are org-scoped
 * in the URL: `/api/orgs/:orgId/llm-routing-policy[/test]`.
 *
 * - GET  returns `{ source: 'org'|'seed', policy, record }` directly (no
 *   `{ success, data }` envelope) — getEffectiveLlmRoutingPolicy().
 * - PUT  requires `{ policy: {...} }` in the body (400 if missing/not an
 *   object) and additionally 403s unless the caller has
 *   ORG_MANAGE_SETTINGS. Returns `{ saved: true, policy }` or
 *   `{ error: 'invalid_policy', validation_errors: [...] }` (400) on a
 *   policy that fails validateLlmRoutingPolicy().
 * - POST .../test also requires `{ policy: {...} }` and returns the raw
 *   validation result `{ valid, errors }` — it does NOT persist anything,
 *   it's a dry-run validator only.
 */

export const llmPolicy = {
  'llm-policy.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/llm-routing-policy`,
    tags: ['live-safe'],
  },
  'llm-policy.set': {
    method: 'PUT',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/llm-routing-policy`,
    tags: ['live-write'],
  },
  'llm-policy.test': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/llm-routing-policy/test`,
    tags: ['live-write'],
  },
};
