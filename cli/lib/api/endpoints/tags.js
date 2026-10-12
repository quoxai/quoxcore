/**
 * 'tags.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const tags = {
  'tags.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/tags`,
    tags: ['live-write'],
  },
  'tags.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, tagId }) => `/api/orgs/${orgId}/tags/${tagId}`,
    tags: ['live-write'],
  },
  'tags.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/tags`,
    tags: ['live-safe'],
  },
  'tags.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId, tagId }) => `/api/orgs/${orgId}/tags/${tagId}`,
    tags: ['live-write'],
  },
};
