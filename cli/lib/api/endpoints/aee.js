/**
 * 'aee.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const aee = {
  'aee.conversations.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/aee/conversations`,
    tags: ['live-safe'],
  },
  'aee.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/aee/${id}`,
    tags: ['live-safe'],
  },
  'aee.query.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/aee/query`,
    tags: ['live-safe'],
  },
  'aee.stats.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/aee/stats`,
    tags: ['live-safe'],
  },
  'aee.store': {
    method: 'POST',
    service: 'collector',
    path: () => `/aee/store`,
    tags: ['live-write'],
  },
};
