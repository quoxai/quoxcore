/**
 * 'awareness.*' endpoints: QuoxAwareness ledger (cross-surface situational awareness).
 * Collector routes: POST/GET /api/v1/awareness, GET /api/v1/awareness/summary,
 * DELETE /api/v1/awareness/:key. Org-scoped, requireServiceOrUserAuth.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const awareness = {
  'awareness.post': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/awareness`,
    tags: ['live-write'],
  },
  'awareness.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/awareness`,
    tags: ['live-safe'],
  },
  'awareness.summary': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/awareness/summary`,
    tags: ['live-safe'],
  },
  'awareness.remove': {
    method: 'DELETE',
    service: 'collector',
    path: ({ key }) => `/api/v1/awareness/${encodeURIComponent(key)}`,
    tags: ['live-write'],
  },
};
