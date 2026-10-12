/**
 * 'memory.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const memory = {
  'memory.create': {
    method: 'POST',
    service: 'memory',
    path: () => `/api/memory`,
    tags: ['live-write'],
  },
  'memory.delete': {
    method: 'DELETE',
    service: 'memory',
    path: ({ id }) => `/api/memory/${id}`,
    tags: ['live-write'],
  },
  'memory.export.list': {
    method: 'GET',
    service: 'memory',
    path: () => `/api/memory/export`,
    tags: ['live-safe'],
  },
  'memory.get': {
    method: 'GET',
    service: 'memory',
    path: ({ id }) => `/api/memory/${id}`,
    tags: ['live-safe'],
  },
  'memory.list': {
    method: 'GET',
    service: 'memory',
    path: () => `/api/memory`,
    tags: ['live-safe'],
  },
  'memory.search.list': {
    method: 'GET',
    service: 'memory',
    path: () => `/api/memory/search`,
    tags: ['live-safe'],
  },
  'memory.stats.list': {
    method: 'GET',
    service: 'memory',
    path: () => `/api/memory/stats`,
    tags: ['live-safe'],
  },
  // Codex cycle 4 #10: decision timeline + correction queue.
  'memory.history': {
    method: 'GET',
    service: 'memory',
    path: ({ id }) => `/api/memory/${id}/history`,
    tags: ['live-safe'],
  },
  'memory.timeline': {
    method: 'GET',
    service: 'memory',
    path: () => `/api/memory/timeline`,
    tags: ['live-safe'],
  },
  'memory.reinstate': {
    method: 'POST',
    service: 'memory',
    path: ({ id }) => `/api/memory/${id}/reinstate`,
    tags: ['live-write'],
  },
  'memory.update': {
    method: 'PATCH',
    service: 'memory',
    path: ({ id }) => `/api/memory/${id}`,
    tags: ['live-write'],
  },
};
