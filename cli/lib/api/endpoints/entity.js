/**
 * 'entity.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const entity = {
  'entity.create': {
    method: 'POST',
    service: 'memory',
    path: () => `/api/entity`,
    tags: ['live-write'],
  },
  'entity.get': {
    method: 'GET',
    service: 'memory',
    path: ({ id }) => `/api/entity/${id}`,
    tags: ['live-safe'],
  },
  'entity.delete': {
    method: 'DELETE',
    service: 'memory',
    path: ({ id }) => `/api/entity/${id}`,
    tags: ['live-write'],
  },
  'entity.list': {
    method: 'GET',
    service: 'memory',
    path: () => `/api/entity`,
    tags: ['live-safe'],
  },
  'entity.relation': {
    method: 'POST',
    service: 'memory',
    path: () => `/api/entity/relation`,
    tags: ['live-write'],
  },
  'entity.relation.delete': {
    method: 'DELETE',
    service: 'memory',
    path: ({ id }) => `/api/entity/relation/${id}`,
    tags: ['live-write'],
  },
  'entity.search.list': {
    method: 'GET',
    service: 'memory',
    path: () => `/api/entity/search`,
    tags: ['live-safe'],
  },
};
