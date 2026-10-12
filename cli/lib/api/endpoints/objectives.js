/**
 * 'objectives.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const objectives = {
  'objectives.approve-plan': {
    method: 'POST',
    service: 'tasks',
    path: ({ id }) => `/api/objectives/${id}/approve-plan`,
    tags: ['live-write'],
  },
  'objectives.checkpoint-approve': {
    method: 'POST',
    service: 'tasks',
    path: ({ id, checkpointId }) => `/api/objectives/${id}/checkpoints/${checkpointId}/approve`,
    tags: ['live-write'],
  },
  'objectives.checkpoint-reject': {
    method: 'POST',
    service: 'tasks',
    path: ({ id, checkpointId }) => `/api/objectives/${id}/checkpoints/${checkpointId}/reject`,
    tags: ['live-write'],
  },
  'objectives.checkpoints-pending': {
    method: 'GET',
    service: 'tasks',
    path: () => `/api/checkpoints/pending`,
    tags: ['live-safe'],
  },
  'objectives.create': {
    method: 'POST',
    service: 'tasks',
    path: () => `/api/objectives`,
    tags: ['live-write'],
  },
  'objectives.get': {
    method: 'GET',
    service: 'tasks',
    path: ({ id }) => `/api/objectives/${id}`,
    tags: ['live-safe'],
  },
  'objectives.halt': {
    method: 'POST',
    service: 'tasks',
    path: ({ id }) => `/api/objectives/${id}/halt`,
    tags: ['live-write'],
  },
  'objectives.list': {
    method: 'GET',
    service: 'tasks',
    path: () => `/api/objectives`,
    tags: ['live-safe'],
  },
  'objectives.start': {
    method: 'POST',
    service: 'tasks',
    path: ({ id }) => `/api/objectives/${id}/start`,
    tags: ['live-write'],
  },
};
