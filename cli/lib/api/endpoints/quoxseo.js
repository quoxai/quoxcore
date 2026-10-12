/**
 * 'quoxseo.*' endpoints — QuoxSEO, the witnessed SEO warehouse (QUOXSEO S2).
 * Proxied through the collector (services/collector/server.js:
 * app.all('/api/v1/quoxseo/*', ...) rewrites to QUOXSEO_URL/api/v1/*, port
 * 3110, repo quoxai/quox-seo). Entitlement-gated from the first commit; a
 * 403 is the licence gate working. The surface is read-only by design bar
 * ONE governed mutation, site registration (quox#583): ingest and witnessing
 * run on a server-side timer, never through HTTP.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const quoxseo = {
  'quoxseo.health': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/quoxseo/health`,
    tags: ['live-safe'],
  },
  'quoxseo.summary': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/quoxseo/summary`,
    tags: ['live-safe'],
  },
  'quoxseo.urls': {
    method: 'GET',
    service: 'collector',
    path: ({ query = '' }) => `/api/v1/quoxseo/urls${query}`,
    tags: ['live-safe'],
  },
  'quoxseo.url.detail': {
    method: 'GET',
    service: 'collector',
    path: ({ path: urlPath }) => `/api/v1/quoxseo/urls/detail?path=${encodeURIComponent(urlPath)}`,
    tags: ['live-safe'],
  },
  'quoxseo.crawls': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/quoxseo/crawls`,
    tags: ['live-safe'],
  },
  'quoxseo.changes': {
    method: 'GET',
    service: 'collector',
    path: ({ query = '' }) => `/api/v1/quoxseo/changes${query}`,
    tags: ['live-safe'],
  },
  'quoxseo.verify': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/quoxseo/verify`,
    tags: ['live-safe'],
  },
  'quoxseo.trends': {
    method: 'GET',
    service: 'collector',
    path: ({ query = '' }) => `/api/v1/quoxseo/trends${query}`,
    tags: ['live-safe'],
  },
  'quoxseo.inspection': {
    method: 'GET',
    service: 'collector',
    path: ({ query = '' }) => `/api/v1/quoxseo/inspection${query}`,
    tags: ['live-safe'],
  },
  // quox#583: the org's registered properties, and the one governed write.
  'quoxseo.sites': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/quoxseo/properties`,
    tags: ['live-safe'],
  },
  'quoxseo.sites.add': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/quoxseo/sites`,
  },
  // quox#676: governed report delivery (email via instance SMTP and/or the HITL
  // inbox, AEE-witnessed at the collector).
  'quoxseo.report.deliver': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/quoxseo/report/deliver`,
  },
  // Paid layer (DataForSEO), read-only over data already bought and persisted
  // by the CLI/scheduler; these three never trigger a paid DataForSEO call
  // themselves. See quox-seo/server/src/server.mjs for the route handlers.
  'quoxseo.keywords': {
    method: 'GET',
    service: 'collector',
    path: ({ query = '' }) => `/api/v1/quoxseo/keywords${query}`,
    tags: ['live-safe'],
  },
  'quoxseo.gaps': {
    method: 'GET',
    service: 'collector',
    path: ({ query = '' }) => `/api/v1/quoxseo/gaps${query}`,
    tags: ['live-safe'],
  },
  'quoxseo.backlinks': {
    method: 'GET',
    service: 'collector',
    path: ({ query = '' }) => `/api/v1/quoxseo/backlinks${query}`,
    tags: ['live-safe'],
  },
};
