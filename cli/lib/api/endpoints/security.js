/**
 * 'security.*' endpoints — WP3.1 (docs/STREAM_CLI_PARITY_PLAN.md §2.3 #6).
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * Backend: services/auth/routes/orgSecurity.js, mounted at plain `/api`
 * (server.js:580 `app.use('/api', orgSecurityRoutes)`) — org-scoped IN the
 * URL (`/api/orgs/:orgId/security/...`). Gated enterprise-tier +
 * ORG_MANAGE_SETTINGS. Verified at the handler: session-policy and
 * ip-allowlist both resolve through `req.org.id`; mfa reads/writes
 * `req.org.security_flags_json` directly off the already-org-scoped
 * `req.org` row. No cross-tenant path.
 *
 * NAMING NOTE: the source file is `orgSecurity.js` but this fragment is
 * named `security.js` (not `org-security.js`) so its endpoint keys can use
 * the `security.*` prefix required by the fragment guard
 * (test/api/endpoints-fragments.test.js requires key prefix === filename
 * minus '.js'). A domain of `org-security` would force `org-security.*`
 * keys instead. `security` does NOT collide with the existing `mfa.js`
 * fragment — that file covers the PERSONAL user MFA enrollment endpoints
 * (`/api/mfa/setup|disable|verify-setup|backup-codes`), distinct from this
 * ORG-LEVEL MFA policy (`/api/orgs/:orgId/security/mfa`, which sets the
 * org-wide required/optional/disabled mode, not a specific user's MFA
 * enrollment).
 */

export const security = {
  'security.ip-allowlist.add': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/security/ip-allowlist`,
    tags: ['live-write'],
  },
  'security.ip-allowlist.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/security/ip-allowlist`,
    tags: ['live-safe'],
  },
  'security.ip-allowlist.remove': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, entryId }) => `/api/orgs/${orgId}/security/ip-allowlist/${entryId}`,
    tags: ['live-write'],
  },
  'security.mfa.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/security/mfa`,
    tags: ['live-safe'],
  },
  'security.mfa.set': {
    method: 'PUT',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/security/mfa`,
    tags: ['live-write'],
  },
  'security.session-policy.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/security/session-policy`,
    tags: ['live-safe'],
  },
  'security.session-policy.set': {
    method: 'PUT',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/security/session-policy`,
    tags: ['live-write'],
  },
};
