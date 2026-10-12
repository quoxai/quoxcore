/**
 * 'webhooks.*' endpoints — WP2.2 (docs/STREAM_CLI_PARITY_PLAN.md §2.3 #2).
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * Backend: services/auth/routes/webhooks.js, mounted at plain `/api`
 * (server.js:641 `app.use('/api', webhooksRoutes)`) — routes are org-scoped
 * IN the URL (`/api/orgs/:orgId/webhooks...`), unlike prompts.js. Gated
 * enterprise-tier + ORG_MANAGE_SETTINGS (requirePlan('enterprise') +
 * resolveCap(Capabilities.ORG_MANAGE_SETTINGS) — services/auth/routes/webhooks.js
 * `chain`). Expect 402/403 on non-enterprise orgs; that's a real route, not
 * a phantom.
 *
 * These are org WEBHOOK SUBSCRIBERS (team_event fan-out targets), distinct
 * from quoxflow's workflow-trigger webhooks in ./triggers.js — the latter
 * are inbound webhook paths registered by an activated workflow node; these
 * are outbound subscriptions this org owns for receiving team_event
 * notifications. SCIM tokens + team-events reads on the same router file
 * are explicitly out of scope for this WP (separate work packages).
 */

export const webhooks = {
  'webhooks.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/webhooks`,
    tags: ['live-write'],
  },
  'webhooks.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, id }) => `/api/orgs/${orgId}/webhooks/${id}`,
    tags: ['live-write'],
  },
  'webhooks.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/webhooks`,
    tags: ['live-safe'],
  },
  'webhooks.rotate': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, id }) => `/api/orgs/${orgId}/webhooks/${id}/rotate`,
    tags: ['live-write'],
  },
};
