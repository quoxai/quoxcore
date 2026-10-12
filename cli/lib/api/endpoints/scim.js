/**
 * 'scim.*' endpoints — WP3.1 (docs/STREAM_CLI_PARITY_PLAN.md §2.3 #6).
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * Backend: services/auth/routes/webhooks.js, mounted at plain `/api`
 * (server.js `app.use('/api', webhooksRoutes)`) — org-scoped IN the URL
 * (`/api/orgs/:orgId/scim/tokens...`). Same enterprise-tier +
 * ORG_MANAGE_SETTINGS `chain` as the webhooks.* routes on this router, but
 * a distinct resource (SCIM bearer tokens for IdP-driven directory sync,
 * not team_event fan-out subscribers) — deliberately out of scope for the
 * `webhooks.*` fragment/WP2.2 per that fragment's header note, and given
 * its own domain here.
 *
 * Verified at the handler: list/create/delete all resolve through
 * `req.org.id` (services/auth/utils/scimTokens.js — every query includes
 * `WHERE org_id = ?`), so a tokenId from another org cannot be revoked.
 *
 * `scim.tokens.create`'s response body is NOT wrapped in `{ token: {...} }`
 * — it's the raw `{ id, token }` shape returned by `createScimToken()`
 * (webhooks.js `res.status(201).json(out)`), where `token` is the
 * plaintext bearer credential, shown exactly once. Every other route on
 * this fragment (and `webhooks.*`) wraps its payload under a named key;
 * this one does not. Reproduced faithfully — do not add a wrapper key
 * without changing the backend route.
 */

export const scim = {
  'scim.tokens.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/scim/tokens`,
    tags: ['live-write'],
  },
  'scim.tokens.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, tokenId }) => `/api/orgs/${orgId}/scim/tokens/${tokenId}`,
    tags: ['live-write'],
  },
  'scim.tokens.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/scim/tokens`,
    tags: ['live-safe'],
  },
};
