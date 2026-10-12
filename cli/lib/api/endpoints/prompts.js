/**
 * 'prompts.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const prompts = {
  // Prompts library (WP2.4, auth/routes/prompts.js) — NOT org-scoped in the URL
  // (mounted at plain `/api/prompts`, server.js:726); org_id travels as a query
  // param on GETs and a body field on writes. Verified at the handler: the
  // DELETE route's `req.body || req.query` fallback never actually reaches
  // req.query in practice because express.json() always leaves req.body as a
  // truthy `{}` on a bodyless request — so org_id MUST be sent in the body
  // for prompts.delete, not the query string.
  'prompts.create': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/prompts`,
    tags: ['live-write'],
  },
  'prompts.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ id }) => `/api/prompts/${id}`,
    tags: ['live-write'],
  },
  'prompts.export': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/prompts/export`,
    tags: ['live-safe'],
  },
  'prompts.get': {
    method: 'GET',
    service: 'auth',
    path: ({ id }) => `/api/prompts/${id}`,
    tags: ['live-safe'],
  },
  'prompts.import': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/prompts/import`,
    tags: ['live-write'],
  },
  'prompts.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/prompts`,
    tags: ['live-safe'],
  },
  'prompts.restore': {
    method: 'POST',
    service: 'auth',
    path: ({ id, version }) => `/api/prompts/${id}/restore/${version}`,
    tags: ['live-write'],
  },
  'prompts.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ id }) => `/api/prompts/${id}`,
    tags: ['live-write'],
  },
  'prompts.versions': {
    method: 'GET',
    service: 'auth',
    path: ({ id }) => `/api/prompts/${id}/versions`,
    tags: ['live-safe'],
  },
};
