/**
 * 'away.*' endpoints: E5 "What happened while I was away?" (`/away` in the quox client).
 * Collector route GET /api/v1/away?since=<iso> (org + user scoped, requireServiceOrUserAuth).
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const away = {
  'away.digest': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/away`,
    tags: ['live-safe'],
  },
};
