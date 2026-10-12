/**
 * 'mfa.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const mfa = {
  'mfa.backup-codes.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/mfa/backup-codes`,
    tags: ['live-safe'],
  },
  'mfa.disable': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/mfa/disable`,
    tags: ['live-write'],
  },
  'mfa.setup': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/mfa/setup`,
    tags: ['live-write'],
  },
  'mfa.verify-setup': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/mfa/verify-setup`,
    tags: ['live-write'],
  },
};
