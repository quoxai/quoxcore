/**
 * 'domains.*' endpoints — WP3.1 (docs/STREAM_CLI_PARITY_PLAN.md §2.3 #6).
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * Backend: services/auth/routes/domains.js, mounted at plain `/api`
 * (server.js:640 `app.use('/api', domainsRoutes)`) — org-scoped IN the URL
 * (`/api/orgs/:orgId/domains...`). Gated team-tier+ + ORG_MANAGE_SETTINGS.
 * Verified at the handler: list/create/verify/delete all operate through
 * `req.org.id` (domainVerification.js helpers take orgId as an explicit
 * param on every query), so a domainId from another org is not reachable.
 */

export const domains = {
  'domains.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/domains`,
    tags: ['live-write'],
  },
  'domains.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, domainId }) => `/api/orgs/${orgId}/domains/${domainId}`,
    tags: ['live-write'],
  },
  'domains.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/domains`,
    tags: ['live-safe'],
  },
  'domains.verify': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, domainId }) => `/api/orgs/${orgId}/domains/${domainId}/verify`,
    tags: ['live-write'],
  },
};
