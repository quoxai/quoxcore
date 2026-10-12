/**
 * 'inbox.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const inbox = {
  'inbox.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, itemId }) => `/api/orgs/${orgId}/inbox/${itemId}`,
    tags: ['live-safe'],
  },
  'inbox.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/inbox`,
    tags: ['live-safe'],
  },
  'inbox.respond': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, itemId }) => `/api/orgs/${orgId}/inbox/${itemId}/respond`,
    tags: ['live-write'],
  },
  'inbox.stats.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/inbox/stats`,
    tags: ['live-safe'],
  },
};
