/**
 * 'tools.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const tools = {
  'tools.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/tools`,
    tags: ['live-write'],
  },
  'tools.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, toolId }) => `/api/orgs/${orgId}/tools/${toolId}`,
    tags: ['live-write'],
  },
  'tools.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, toolId }) => `/api/orgs/${orgId}/tools/${toolId}`,
    tags: ['live-safe'],
  },
  'tools.install-to-scope': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/tools/install-to-scope`,
    tags: ['live-write'],
  },
  'tools.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/tools`,
    tags: ['live-safe'],
  },
  'tools.publish': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, toolId }) => `/api/orgs/${orgId}/tools/${toolId}/publish`,
    tags: ['live-write'],
  },
  'tools.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId, toolId }) => `/api/orgs/${orgId}/tools/${toolId}`,
    tags: ['live-write'],
  },
};
