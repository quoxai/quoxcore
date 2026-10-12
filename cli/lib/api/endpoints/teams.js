/**
 * 'teams.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const teams = {
  'teams.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/teams`,
    tags: ['live-write'],
  },
  'teams.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, teamId }) => `/api/orgs/${orgId}/teams/${teamId}`,
    tags: ['live-write'],
  },
  'teams.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, teamId }) => `/api/orgs/${orgId}/teams/${teamId}`,
    tags: ['live-safe'],
  },
  'teams.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/teams`,
    tags: ['live-safe'],
  },
  'teams.members.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, teamId }) => `/api/orgs/${orgId}/teams/${teamId}/members`,
    tags: ['live-write'],
  },
  'teams.members.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, teamId, user }) => `/api/orgs/${orgId}/teams/${teamId}/members/${user}`,
    tags: ['live-write'],
  },
  'teams.provisionRoom': {
    method: 'POST',
    service: 'tasks',
    path: ({ teamId }) => `/api/teams/${teamId}/provision-room`,
    tags: ['live-write'],
  },
  'teams.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId, teamId }) => `/api/orgs/${orgId}/teams/${teamId}`,
    tags: ['live-write'],
  },
};
