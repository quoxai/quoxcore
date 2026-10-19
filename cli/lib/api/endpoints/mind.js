/**
 * 'mind.*' endpoints: QuoxMind cognitive implants (read-only).
 * Collector routes: GET /api/v1/mind/implants, /api/v1/mind/implants/:id,
 * /api/v1/mind/health, /api/v1/mind/mirror (the compact System Status block CommanderQ
 * is given, plus its age). Org-scoped, requireServiceOrUserAuth.
 */

export const mind = {
  'mind.implants': { method: 'GET', service: 'collector', path: () => `/api/v1/mind/implants`, tags: ['live-safe'] },
  'mind.implant': { method: 'GET', service: 'collector', path: ({ id }) => `/api/v1/mind/implants/${encodeURIComponent(id)}`, tags: ['live-safe'] },
  'mind.health': { method: 'GET', service: 'collector', path: () => `/api/v1/mind/health`, tags: ['live-safe'] },
  'mind.mirror': { method: 'GET', service: 'collector', path: () => `/api/v1/mind/mirror`, tags: ['live-safe'] },
};
