/**
 * 'quoxflow.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const quoxflow = {
  'quoxflow.evidence.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/quoxflow/evidence`,
    tags: ['live-safe'],
  },
  'quoxflow.observations.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/quoxflow/observations`,
    tags: ['live-safe'],
  },
  'quoxflow.skills.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/quoxflow/skills/${id}`,
    tags: ['live-safe'],
  },
  'quoxflow.skills.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/quoxflow/skills`,
    tags: ['live-safe'],
  },
};
