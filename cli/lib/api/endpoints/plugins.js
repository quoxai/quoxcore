/**
 * 'plugins.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const plugins = {
  // Plugins (WP2.1, auth/routes/plugins.js) — org-scoped install registry.
  // Install/update/uninstall + all secrets writes are admin-only; reads
  // require org membership only. assignments.delete's assigneeId path
  // segment is optional (the route is `.../assignments/:assigneeType/:assigneeId?`).
  'plugins.assignments.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, pluginId }) => `/api/orgs/${orgId}/plugins/${pluginId}/assignments`,
    tags: ['live-write'],
  },
  'plugins.assignments.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, pluginId, assigneeType, assigneeId }) => assigneeId
      ? `/api/orgs/${orgId}/plugins/${pluginId}/assignments/${assigneeType}/${assigneeId}`
      : `/api/orgs/${orgId}/plugins/${pluginId}/assignments/${assigneeType}`,
    tags: ['live-write'],
  },
  'plugins.assignments.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, pluginId }) => `/api/orgs/${orgId}/plugins/${pluginId}/assignments`,
    tags: ['live-safe'],
  },
  'plugins.data.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, pluginId, key }) => `/api/orgs/${orgId}/plugins/${pluginId}/data/${key}`,
    tags: ['live-write'],
  },
  'plugins.data.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, pluginId, key }) => `/api/orgs/${orgId}/plugins/${pluginId}/data/${key}`,
    tags: ['live-safe'],
  },
  'plugins.data.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, pluginId }) => `/api/orgs/${orgId}/plugins/${pluginId}/data`,
    tags: ['live-safe'],
  },
  'plugins.data.set': {
    method: 'PUT',
    service: 'auth',
    path: ({ orgId, pluginId, key }) => `/api/orgs/${orgId}/plugins/${pluginId}/data/${key}`,
    tags: ['live-write'],
  },
  'plugins.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, pluginId }) => `/api/orgs/${orgId}/plugins/${pluginId}`,
    tags: ['live-safe'],
  },
  'plugins.install': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/plugins`,
    tags: ['live-write'],
  },
  'plugins.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/plugins`,
    tags: ['live-safe'],
  },
  'plugins.mine.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/me/plugins`,
    tags: ['live-safe'],
  },
  'plugins.secrets.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, pluginId, name }) => `/api/orgs/${orgId}/plugins/${pluginId}/secrets/${name}`,
    tags: ['live-write'],
  },
  'plugins.secrets.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, pluginId }) => `/api/orgs/${orgId}/plugins/${pluginId}/secrets`,
    tags: ['live-safe'],
  },
  'plugins.secrets.reveal': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, pluginId, name }) => `/api/orgs/${orgId}/plugins/${pluginId}/secrets/${name}/reveal`,
    tags: ['live-write'],
  },
  'plugins.secrets.set': {
    method: 'PUT',
    service: 'auth',
    path: ({ orgId, pluginId, name }) => `/api/orgs/${orgId}/plugins/${pluginId}/secrets/${name}`,
    tags: ['live-write'],
  },
  'plugins.revocations.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/plugin-revocations`,
    tags: ['live-write'],
  },
  'plugins.revocations.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, revocationId }) => `/api/orgs/${orgId}/plugin-revocations/${revocationId}`,
    tags: ['live-write'],
  },
  'plugins.revocations.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/plugin-revocations`,
    tags: ['live-safe'],
  },
  'plugins.trusted-keys.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/trusted-keys`,
    tags: ['live-write'],
  },
  'plugins.trusted-keys.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, keyId }) => `/api/orgs/${orgId}/trusted-keys/${keyId}`,
    tags: ['live-write'],
  },
  'plugins.trusted-keys.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/trusted-keys`,
    tags: ['live-safe'],
  },
  'plugins.uninstall': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, pluginId }) => `/api/orgs/${orgId}/plugins/${pluginId}`,
    tags: ['live-write'],
  },
  'plugins.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId, pluginId }) => `/api/orgs/${orgId}/plugins/${pluginId}`,
    tags: ['live-write'],
  },
};
