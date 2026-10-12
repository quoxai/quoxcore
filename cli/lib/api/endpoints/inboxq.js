/**
 * 'inboxq.*' endpoints — InboxQ (governed email-management plugin), proxied
 * through the collector (services/collector/server.js:
 * /api/v1/inboxq/* -> InboxQ routes, org resolved server-side from auth).
 * No org segment in the URL — same shape as `quoxplan.*`/`quoxbox.*`.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const inboxq = {
  'inboxq.accounts.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/inboxq/accounts`,
    tags: ['live-safe'],
  },
  'inboxq.accounts.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/inboxq/accounts`,
    tags: ['live-write'],
  },
  'inboxq.accounts.delete': {
    method: 'DELETE',
    service: 'collector',
    path: ({ accountId }) => `/api/v1/inboxq/accounts/${accountId}`,
    tags: ['live-write'],
  },
  'inboxq.messages.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/api/v1/inboxq/messages/${encodeURIComponent(id)}`,
    tags: ['live-safe'],
  },
  'inboxq.messages.fetchBody': {
    method: 'POST',
    service: 'collector',
    path: ({ id }) => `/api/v1/inboxq/messages/${encodeURIComponent(id)}/fetch-body`,
    tags: ['live-write'],
  },
  'inboxq.messages.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/inboxq/messages`,
    tags: ['live-safe'],
  },
  'inboxq.zones.get': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/inboxq/zones`,
    tags: ['live-safe'],
  },
  // AQ-9E U2: reversible moves
  'inboxq.moves.recent': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/inboxq/moves/recent`,
    tags: ['live-safe'],
  },
  'inboxq.moves.undo': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/inboxq/moves/undo`,
    tags: ['live-write'],
  },
  'inboxq.sync': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/inboxq/sync`,
    tags: ['live-write'],
  },
  'inboxq.report.generate': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/inboxq/report/generate`,
    tags: ['live-write'],
  },
  'inboxq.report.latest': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/inboxq/report/latest`,
    tags: ['live-safe'],
  },
  'inboxq.watches.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/inboxq/watches`,
    tags: ['live-safe'],
  },
  'inboxq.watches.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/inboxq/watches`,
    tags: ['live-write'],
  },
  'inboxq.watches.active': {
    method: 'POST',
    service: 'collector',
    path: ({ watchId }) => `/api/v1/inboxq/watches/${watchId}/active`,
    tags: ['live-write'],
  },
  'inboxq.proposals.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/inboxq/proposals`,
    tags: ['live-safe'],
  },
  'inboxq.proposals.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/inboxq/proposals`,
    tags: ['live-write'],
  },
  'inboxq.proposals.resolve': {
    method: 'POST',
    service: 'collector',
    path: ({ proposalId }) => `/api/v1/inboxq/proposals/${proposalId}/resolve`,
    tags: ['live-write'],
  },
};
