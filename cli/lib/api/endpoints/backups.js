/**
 * 'backups.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const backups = {
  'backups.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/backups`,
    tags: ['live-write'],
  },
  'backups.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, backupId }) => `/api/orgs/${orgId}/backups/${backupId}`,
    tags: ['live-write'],
  },
  'backups.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, backupId }) => `/api/orgs/${orgId}/backups/${backupId}`,
    tags: ['live-safe'],
  },
  'backups.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/backups`,
    tags: ['live-safe'],
  },
  'backups.restore': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, backupId }) => `/api/orgs/${orgId}/backups/${backupId}/restore`,
    tags: ['live-write'],
  },
  'backups.verify': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, backupId }) => `/api/orgs/${orgId}/backups/${backupId}/verify`,
    tags: ['live-write'],
  },

  // ── G2d slice 3: the INSTANCE-ADMIN, SERVER-WIDE lane ───────────────────
  // Everything above is the per-ORG tenant lane (:orgId scoped). These are
  // the whole-box lane behind services/auth/routes/admin-backups.js: no org
  // in the path, instance-admin only, and the work runs on the governed
  // host-side runner. Driven by `quox backup server …`.
  'backups.server.list': {
    method: 'GET',
    service: 'auth',
    path: () => '/api/admin/backups',
    tags: ['live-safe'],
  },
  'backups.server.status': {
    method: 'GET',
    service: 'auth',
    path: () => '/api/admin/backups/status',
    tags: ['live-safe'],
  },
  'backups.server.create': {
    method: 'POST',
    service: 'auth',
    path: () => '/api/admin/backups',
    tags: ['live-write'],
  },
  'backups.server.download': {
    method: 'GET',
    service: 'auth',
    path: ({ archiveId }) => `/api/admin/backups/${encodeURIComponent(archiveId)}/download`,
    tags: ['live-safe'],
  },
  'backups.server.restore': {
    method: 'POST',
    service: 'auth',
    path: ({ archiveId }) => `/api/admin/backups/${encodeURIComponent(archiveId)}/restore`,
    tags: ['live-write'],
  },
  'backups.server.restoreStatus': {
    method: 'GET',
    service: 'auth',
    path: () => '/api/admin/backups/restore-status',
    tags: ['live-safe'],
  },
};
