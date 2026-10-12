/**
 * 'orgs.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const orgs = {
  'orgs.create': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/orgs`,
    tags: ['live-write'],
  },
  'orgs.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}`,
    tags: ['live-write'],
  },
  'orgs.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}`,
    tags: ['live-safe'],
  },
  'orgs.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/orgs`,
    tags: ['live-safe'],
  },
  'orgs.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}`,
    tags: ['live-write'],
  },
};
