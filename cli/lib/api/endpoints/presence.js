/**
 * 'presence.*' endpoints: PRESENCE (owner 2026-10-16). /afk, /sleep, /back in quox, `quox presence`.
 * Collector routes GET/PUT /api/v1/presence (org from the verified caller; only a human login sets its own).
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const presence = {
  'presence.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/presence`,
    tags: ['live-safe'],
  },
  'presence.get': {
    method: 'GET',
    service: 'collector',
    path: ({ who }) => `/api/v1/presence/${encodeURIComponent(who)}`,
    tags: ['live-safe'],
  },
  'presence.activity': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/presence/activity`,
    tags: ['live-write'],
  },
  'presence.set': {
    method: 'PUT',
    service: 'collector',
    path: () => `/api/v1/presence`,
    tags: ['live-write'],
  },
};
