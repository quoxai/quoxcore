/**
 * 'runs.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const runs = {
  'runs.cancel': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, runId }) => `/api/orgs/${orgId}/runs/${runId}/cancel`,
    tags: ['live-write'],
  },
  'runs.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/runs`,
    tags: ['live-write'],
  },
  'runs.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, pollRunId }) => `/api/orgs/${orgId}/runs/${pollRunId}`,
    tags: ['live-safe'],
  },
  'runs.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/runs`,
    tags: ['live-safe'],
  },
  'runs.resume': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, runId }) => `/api/orgs/${orgId}/runs/${runId}/resume`,
    tags: ['live-write'],
  },
};
