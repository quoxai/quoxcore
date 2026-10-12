/**
 * 'lucid.*' endpoints: LUCID situational-awareness journal (`quox lucid`).
 * Collector routes under /api/v1/lucid (org-scoped, requireServiceOrUserAuth).
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const lucid = {
  'lucid.situation': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/lucid/situation`,
    tags: ['live-safe'],
  },
  'lucid.ack': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/lucid/ack`,
    tags: ['live-write'],
  },
  'lucid.subjects': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/lucid/subjects`,
    tags: ['live-safe'],
  },
  'lucid.feeds': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/lucid/feeds`,
    tags: ['live-safe'],
  },
  'lucid.journal': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/lucid/journal`,
    tags: ['live-safe'],
  },
  'lucid.replay': { method: 'GET', service: 'collector', path: () => `/api/v1/lucid/replay`, tags: ['live-safe'] },
  'lucid.told': { method: 'GET', service: 'collector', path: () => `/api/v1/lucid/told`, tags: ['live-safe'] },
  'lucid.item': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/lucid/item`,
    tags: ['live-safe'],
  },
  'lucid.measure': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/lucid/measure`,
    tags: ['live-write'],
  },
  'lucid.lessons': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/lucid/lessons`,
    tags: ['live-safe'],
  },
  'lucid.teach': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/lucid/teach`,
    tags: ['live-write'],
  },
  'lucid.lessons.delete': {
    method: 'DELETE',
    service: 'collector',
    path: ({ id }) => `/api/v1/lucid/lessons/${encodeURIComponent(id)}`,
    tags: ['live-write'],
  },
  'lucid.herald': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/lucid/herald`,
    tags: ['live-safe'],
  },
  'lucid.herald.settings': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/lucid/herald/settings`,
    tags: ['live-write'],
  },
  'lucid.herald.test': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/lucid/herald/test`,
    tags: ['live-safe'],
  },
};
