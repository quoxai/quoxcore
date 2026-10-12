/**
 * 'user-library.*' endpoints — WP2.3 (docs/STREAM_CLI_PARITY_PLAN.md §2.3 #3).
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * Per-org/per-user saved workflow library ("My Library"). Backend: the auth
 * service (NOT quoxflow, NOT proxied) — services/auth/routes/user-library.js,
 * mounted at plain `/api` (server.js:724), so the router's own
 * `/orgs/:orgId/user-library` paths are the real, final routes.
 *
 * Always scoped to `user_id = req.user.id` in addition to `org_id` (see the
 * route file's own header comment) — another user in the same org cannot see
 * or delete these entries. No cross-tenant/cross-user leak found here, unlike
 * the quoxflow triggers.* list routes.
 *
 *   POST   /api/orgs/:orgId/user-library         body: { name, description?, definition_json, source?, source_workflow_id?, tags? }
 *                                                 201 { entry } | 400 name/definition_json missing | 409 duplicate name
 *   GET    /api/orgs/:orgId/user-library          query: { source? } ('curated'|'n8n-imported'|'mine')
 *                                                 200 { entries: [...] } ordered by updated_at DESC
 *   DELETE /api/orgs/:orgId/user-library/:id      200 { ok: true } | 404 (not found or wrong owner — same code, no leak)
 */

export const userLibrary = {
  'user-library.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/user-library`,
    tags: ['live-write'],
  },
  'user-library.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, id }) => `/api/orgs/${orgId}/user-library/${id}`,
    tags: ['live-write'],
  },
  'user-library.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/user-library`,
    tags: ['live-safe'],
  },
};
