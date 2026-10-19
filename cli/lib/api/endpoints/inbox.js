/**
 * 'inbox.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const inbox = {
  'inbox.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, itemId }) => `/api/orgs/${orgId}/inbox/${itemId}`,
    tags: ['live-safe'],
  },
  'inbox.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/inbox`,
    tags: ['live-safe'],
  },
  // quox#827: the ONE server-side set of open approvals this user can act on (also backs stats.pending_approvals and LUCID).
  'inbox.approvals.open': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/approvals/open`,
    tags: ['live-safe'],
  },
  'inbox.respond': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, itemId }) => `/api/orgs/${orgId}/inbox/${itemId}/respond`,
    tags: ['live-write'],
  },
  // quox ask: a session files a decision request (one inbox item) and waits for the human's answer.
  'inbox.decision.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/decisions`,
    tags: ['live-write'],
  },
  'inbox.decision.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, id }) => `/api/orgs/${orgId}/decisions/${id}`,
    tags: ['live-safe'],
  },
  'inbox.stats.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/inbox/stats`,
    tags: ['live-safe'],
  },
};
