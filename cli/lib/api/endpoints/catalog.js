/**
 * 'catalog.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const catalog = {
  'catalog.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/catalog`,
    tags: ['live-safe'],
  },
};
