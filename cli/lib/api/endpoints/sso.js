/**
 * 'sso.*' endpoints — WP3.1 (docs/STREAM_CLI_PARITY_PLAN.md §2.3 #6).
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * Backend: services/auth/routes/sso.js, mounted at plain `/api`
 * (server.js:639 `app.use('/api', ssoRoutes)`). The admin CRUD routes below
 * are org-scoped IN the URL (`/api/orgs/:orgId/sso/providers...`) and gated
 * enterprise-tier + ORG_MANAGE_SSO (`chain` in sso.js). Verified at the
 * handler: GET/POST/PATCH/DELETE all resolve the provider through
 * `req.org.id`, so cross-org access is not possible via these routes.
 *
 * The OIDC/SAML browser-flow routes (`/sso/discover`, `/sso/providers/:id/
 * login`, `/callback`, `/saml-login`, `/acs`) are intentionally OUT OF SCOPE
 * for this work package — they are 302-redirect / form-post handshake
 * endpoints, not CLI-shaped.
 *
 * BACKEND FINDING: `sso.providers.samlMetadata` is NOT org-scoped in the
 * URL, unlike the admin CRUD routes. The handler (sso.js:315,
 * `GET /sso/providers/:providerId/saml-metadata`) is grouped with the
 * public SAML user-flow section — no auth/org/plan/capability chain at
 * all, by design ("Public — no PII in metadata" per the route's own
 * docstring). It looks up the provider by `providerId` alone and 400s if
 * that provider's protocol isn't 'saml'. The plan's endpoint list assumed
 * an `/orgs/:orgId/...` shape for this route; the real route has no orgId
 * segment. Reproduced faithfully here — do not add an orgId param to this
 * path without changing the backend route first.
 */

export const sso = {
  'sso.providers.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/sso/providers`,
    tags: ['live-write'],
  },
  'sso.providers.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, providerId }) => `/api/orgs/${orgId}/sso/providers/${providerId}`,
    tags: ['live-write'],
  },
  'sso.providers.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, providerId }) => `/api/orgs/${orgId}/sso/providers/${providerId}`,
    tags: ['live-safe'],
  },
  'sso.providers.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/sso/providers`,
    tags: ['live-safe'],
  },
  // Public route — no orgId segment. See the BACKEND FINDING above.
  'sso.providers.saml-metadata': {
    method: 'GET',
    service: 'auth',
    path: ({ providerId }) => `/api/sso/providers/${providerId}/saml-metadata`,
    tags: ['live-safe'],
  },
  'sso.providers.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId, providerId }) => `/api/orgs/${orgId}/sso/providers/${providerId}`,
    tags: ['live-write'],
  },
};
