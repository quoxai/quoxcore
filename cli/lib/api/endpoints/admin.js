/**
 * 'admin.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const admin = {
  'admin.config.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/admin/config`,
    tags: ['live-safe'],
  },
  'admin.agent_identity.mint': {
    method: 'POST',
    service: 'auth',
    path: () => '/api/admin/agent-identities',
    tags: ['admin-write'],
  },
  // Instance basics after setup (app URL etc). Served by services/auth/routes/admin-instance.js.
  'admin.instance.basics.get': {
    method: 'GET',
    service: 'auth',
    path: () => '/api/admin/instance/basics',
    tags: ['live-safe'],
  },
  'admin.instance.basics.set': {
    method: 'PUT',
    service: 'auth',
    path: () => '/api/admin/instance/basics',
    tags: ['admin-write'],
  },
  // LAN integration targets gate (allow_lan_integration_targets). Served by services/auth/routes/admin-instance.js.
  'admin.instance.lan_targets.get': {
    method: 'GET',
    service: 'auth',
    path: () => '/api/admin/instance/lan-targets',
    tags: ['live-safe'],
  },
  'admin.instance.lan_targets.set': {
    method: 'PUT',
    service: 'auth',
    path: () => '/api/admin/instance/lan-targets',
    tags: ['admin-write'],
  },
  'admin.config.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ key }) => `/api/admin/config/${key}`,
    tags: ['live-write'],
  },
  // LICENSE-LAUNCH LL-6b — enforcement posture + break-glass. Served by
  // services/auth/routes/setup.js; read is any authenticated user, both
  // writes are instance-admin only.
  'admin.enforcement.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/setup/enforcement`,
    tags: ['live-safe'],
  },
  'admin.enforcement.break_glass.open': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/setup/enforcement/break-glass`,
    tags: ['admin-write'],
  },
  'admin.enforcement.break_glass.clear': {
    method: 'DELETE',
    service: 'auth',
    path: ({ flag }) => `/api/setup/enforcement/break-glass/${flag}`,
    tags: ['admin-write'],
  },
  'admin.email.status': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/admin/email/status`,
    tags: ['live-safe'],
  },
  'admin.email.smtp': {
    method: 'PUT',
    service: 'auth',
    path: () => `/api/admin/email/smtp`,
    tags: ['live-write'],
  },
  'admin.email.test': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/admin/email/test`,
    tags: ['live-write'],
  },
  'admin.keys.create': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/admin/keys`,
    tags: ['live-write'],
  },
  'admin.keys.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ keyId }) => `/api/admin/keys/${keyId}`,
    tags: ['live-write'],
  },
  'admin.keys.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/admin/keys`,
    tags: ['live-safe'],
  },
  'admin.keys.test': {
    method: 'POST',
    service: 'auth',
    path: ({ keyId }) => `/api/admin/keys/${keyId}/test`,
    tags: ['live-write'],
  },
  'admin.logs.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/admin/logs`,
    tags: ['live-safe'],
  },
  'admin.retention.cleanup': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/admin/retention/cleanup`,
    tags: ['live-write'],
  },
  'admin.retention.config.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/admin/retention/config`,
    tags: ['live-safe'],
  },
  'admin.retention.stats.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/admin/retention/stats`,
    tags: ['live-safe'],
  },
  'admin.services.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/admin/services`,
    tags: ['live-safe'],
  },
  'admin.stats.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/admin/stats`,
    tags: ['live-safe'],
  },
};
