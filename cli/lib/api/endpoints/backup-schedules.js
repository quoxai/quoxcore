/**
 * 'backup-schedules.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const backupSchedules = {
  'backup-schedules.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/backup-schedules`,
    tags: ['live-write'],
  },
  'backup-schedules.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/backup-schedules`,
    tags: ['live-safe'],
  },
};
