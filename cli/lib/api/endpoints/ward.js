/**
 * 'ward.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const ward = {
  'ward.chains.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/ward/chains`,
    tags: ['live-safe'],
  },
  'ward.entries.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/ward/entries`,
    tags: ['live-safe'],
  },
  // PEEK: one WARD entry (a receipt) by its ward_entry_id; org-scoped for a user login.
  'ward.entries.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/ward/entries/${id}`,
    tags: ['live-safe'],
  },
  'ward.stats.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/ward/stats`,
    tags: ['live-safe'],
  },
  'ward.verify': {
    method: 'POST',
    service: 'collector',
    path: () => `/ward/verify`,
    tags: ['live-write'],
  },
  // #622: bounded single-action receipt verification (entry → covering signed
  // tip only). Safe on the production chain where 'ward.verify' is not.
  'ward.verify_receipt': {
    method: 'POST',
    service: 'collector',
    path: () => `/ward/verify-receipt`,
    tags: ['live-safe'],
  },
};
