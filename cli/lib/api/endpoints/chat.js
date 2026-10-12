/**
 * 'chat.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const chat = {
  'chat.claude': {
    method: 'POST',
    service: 'collector',
    path: () => `/chat/claude`,
    tags: ['live-write'],
  },
  'chat.status.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/chat/status`,
    tags: ['live-safe'],
  },
  'chat.stream': {
    method: 'STREAM',
    service: 'collector',
    path: () => `/chat/stream`,
    tags: ['live-write'],
  },
};
