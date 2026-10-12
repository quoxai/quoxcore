/**
 * 'setup.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const setup = {
  'setup.admin': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/setup/admin`,
    tags: ['live-write'],
  },
  'setup.config': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/setup/config`,
    tags: ['live-write'],
  },
  'setup.config.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/setup/config`,
    tags: ['live-safe'],
  },
  'setup.licensing.activate': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/setup/licensing/activate`,
    tags: ['live-write'],
  },
  // LICENSE-LAUNCH LL-8-dash: device-code activation (no key paste). Both are
  // instance-admin gated on the auth service, which holds the conversation
  // with the control plane.
  'setup.licensing.device.start': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/setup/licensing/device/start`,
    tags: ['live-write'],
  },
  'setup.licensing.device.poll': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/setup/licensing/device/poll`,
    tags: ['live-write'],
  },
  'setup.licensing.deactivate': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/setup/licensing/deactivate`,
    tags: ['live-write'],
  },
  'setup.licensing.entitlements.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/setup/licensing/entitlements`,
    tags: ['live-safe'],
  },
  // GRIPE-715: `quox licence` phase 1.
  'setup.licensing.status': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/setup/licensing/status`,
    tags: ['live-safe'],
  },
  'setup.licensing.refresh': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/setup/licensing/refresh`,
    tags: ['live-write'],
  },
  'setup.licensing.seats.list': {
    method: 'GET',
    service: 'auth',
    path: ({ pluginId }) => `/api/setup/licensing/seats/${encodeURIComponent(pluginId)}`,
    tags: ['live-safe'],
  },
  'setup.licensing.seats.releaseDead': {
    method: 'POST',
    service: 'auth',
    path: ({ pluginId }) => `/api/setup/licensing/seats/${encodeURIComponent(pluginId)}/release-dead`,
    tags: ['live-write'],
  },
  'setup.status.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/setup/status`,
    tags: ['live-safe'],
  },
};
