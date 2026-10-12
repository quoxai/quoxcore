/**
 * 'file.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const file = {
  'file.delete': {
    method: 'DELETE',
    service: 'files',
    path: ({ fileId }) => `/file/${fileId}`,
    tags: ['live-write'],
  },
  'file.get': {
    method: 'GET',
    service: 'files',
    path: ({ fileId }) => `/file/${fileId}`,
    tags: ['live-safe'],
  },
};
