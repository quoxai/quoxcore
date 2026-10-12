/**
 * 'members.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const members = {
  'members.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/members`,
    tags: ['live-write'],
  },
  'members.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, userId }) => `/api/orgs/${orgId}/members/${userId}`,
    tags: ['live-write'],
  },
  'members.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/members`,
    tags: ['live-safe'],
  },
  'members.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId, userId }) => `/api/orgs/${orgId}/members/${userId}`,
    tags: ['live-write'],
  },
};
