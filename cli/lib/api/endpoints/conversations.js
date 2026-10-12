/**
 * 'conversations.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const conversations = {
  'conversations.get': {
    method: 'GET',
    service: 'memory',
    path: ({ id }) => `/api/conversations/${id}`,
    tags: ['live-safe'],
  },
  'conversations.list': {
    method: 'GET',
    service: 'memory',
    path: () => `/api/conversations`,
    tags: ['live-safe'],
  },
  'conversations.search.list': {
    method: 'GET',
    service: 'memory',
    path: () => `/api/conversations/search`,
    tags: ['live-safe'],
  },
  'conversations.stats.list': {
    method: 'GET',
    service: 'memory',
    path: () => `/api/conversations/stats`,
    tags: ['live-safe'],
  },
};
