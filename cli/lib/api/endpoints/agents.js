/**
 * 'agents.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const agents = {
  'agents.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/agents`,
    tags: ['live-write'],
  },
  'agents.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, agentId }) => `/api/orgs/${orgId}/agents/${agentId}`,
    tags: ['live-write'],
  },
  'agents.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, agentId }) => `/api/orgs/${orgId}/agents/${agentId}`,
    tags: ['live-safe'],
  },
  // ASIDE: a no-tools, no-conversation model call (quox aside, the TUI /aside). Spends tokens, changes nothing.
  'agents.invoke.notools': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/internal/agents/invoke`,
    tags: ['skip-live'],
  },
  'agents.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/agents`,
    tags: ['live-safe'],
  },
  'agents.tools.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, agentId }) => `/api/orgs/${orgId}/agents/${agentId}/tools`,
    tags: ['live-write'],
  },
  'agents.tools.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, agentId, id }) => `/api/orgs/${orgId}/agents/${agentId}/tools/${id}`,
    tags: ['live-write'],
  },
  'agents.tools.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, agentId }) => `/api/orgs/${orgId}/agents/${agentId}/tools`,
    tags: ['live-safe'],
  },
  'agents.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId, agentId }) => `/api/orgs/${orgId}/agents/${agentId}`,
    tags: ['live-write'],
  },
};
