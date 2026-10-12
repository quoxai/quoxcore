/**
 * 'divisions.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const divisions = {
  'divisions.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/divisions`,
    tags: ['live-write'],
  },
  'divisions.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, divId }) => `/api/orgs/${orgId}/divisions/${divId}`,
    tags: ['live-write'],
  },
  'divisions.departments.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, division }) => `/api/orgs/${orgId}/divisions/${division}/departments`,
    tags: ['live-write'],
  },
  'divisions.departments.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, division, deptId }) => `/api/orgs/${orgId}/divisions/${division}/departments/${deptId}`,
    tags: ['live-write'],
  },
  'divisions.departments.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, division }) => `/api/orgs/${orgId}/divisions/${division}/departments`,
    tags: ['live-safe'],
  },
  'divisions.departments.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId, division, deptId }) => `/api/orgs/${orgId}/divisions/${division}/departments/${deptId}`,
    tags: ['live-write'],
  },
  'divisions.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/divisions`,
    tags: ['live-safe'],
  },
  'divisions.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId, divId }) => `/api/orgs/${orgId}/divisions/${divId}`,
    tags: ['live-write'],
  },
};
