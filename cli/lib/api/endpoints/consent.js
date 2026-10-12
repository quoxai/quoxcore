/**
 * 'consent.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const consent = {
  'consent.create': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/consent`,
    tags: ['live-write'],
  },
  'consent.history.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/consent/history`,
    tags: ['live-safe'],
  },
  'consent.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/consent`,
    tags: ['live-safe'],
  },
};
