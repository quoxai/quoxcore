/**
 * 'assistants.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const assistants = {
  'assistants.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/assistants`,
    tags: ['live-write'],
  },
  'assistants.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, assistantId }) => `/api/orgs/${orgId}/assistants/${assistantId}`,
    tags: ['live-write'],
  },
  'assistants.deploy': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, assistantId }) => `/api/orgs/${orgId}/assistants/${assistantId}/deploy`,
    tags: ['live-write'],
  },
  'assistants.undeploy': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, assistantId, deploymentId }) => `/api/orgs/${orgId}/assistants/${assistantId}/deployments/${deploymentId}`,
    tags: ['live-write'],
  },
  'assistants.fork': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, assistantId }) => `/api/orgs/${orgId}/assistants/${assistantId}/fork`,
    tags: ['live-write'],
  },
  'assistants.publish': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, assistantId }) => `/api/orgs/${orgId}/assistants/${assistantId}/publish`,
    tags: ['live-write'],
  },
  'assistants.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, assistantId }) => `/api/orgs/${orgId}/assistants/${assistantId}`,
    tags: ['live-safe'],
  },
  'assistants.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/assistants`,
    tags: ['live-safe'],
  },
  'assistants.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId, assistantId }) => `/api/orgs/${orgId}/assistants/${assistantId}`,
    tags: ['live-write'],
  },
};
