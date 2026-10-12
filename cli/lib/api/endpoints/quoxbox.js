/**
 * 'quoxbox.*' endpoints — QuoxBox governed Mac-mini agent gateway, proxied
 * through the collector (services/collector/routes/quoxbox-proxy.js,
 * mounted at /api/quoxbox). Collector-direct, no org segment in the URL —
 * same shape as `traces.*`/`aee.*`/`mon.*`. requireAuth() is applied to
 * every route server-side (org-scoped, no anonymous access), but the
 * gateway itself (and its bearer token) never reach the browser/CLI.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const quoxbox = {
  'quoxbox.live': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/quoxbox/live`,
    tags: ['live-safe'],
  },
  'quoxbox.workflows.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/quoxbox/workflows`,
    tags: ['live-safe'],
  },
  'quoxbox.task.run': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/quoxbox/task/run`,
    tags: ['live-write'],
  },
  'quoxbox.task.get': {
    method: 'GET',
    service: 'collector',
    path: ({ taskId }) => `/api/quoxbox/task/${taskId}`,
    tags: ['live-safe'],
  },
  'quoxbox.approve': {
    method: 'POST',
    service: 'collector',
    path: ({ approvalId }) => `/api/quoxbox/approve/${approvalId}`,
    tags: ['live-write'],
  },
  'quoxbox.deny': {
    method: 'POST',
    service: 'collector',
    path: ({ approvalId }) => `/api/quoxbox/deny/${approvalId}`,
    tags: ['live-write'],
  },
  'quoxbox.mode.set': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/quoxbox/mode`,
    tags: ['live-write'],
  },
};
