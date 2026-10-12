/**
 * 'files.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const files = {
  'files.list': {
    method: 'GET',
    service: 'files',
    path: () => `/list`,
    tags: ['live-safe'],
  },
  'files.stats': {
    method: 'GET',
    service: 'files',
    path: () => `/stats`,
    tags: ['live-safe'],
  },
  'files.upload': {
    method: 'POST',
    service: 'files',
    path: () => `/upload`,
    tags: ['live-write'],
  },
};
