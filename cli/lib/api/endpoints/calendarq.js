/**
 * 'calendarq.*' endpoints — Calendar-Q (governed calendar plugin), proxied
 * through the collector (services/collector/server.js:
 * /api/v1/calendarq/* -> Calendar-Q routes, org resolved server-side from
 * auth). No org segment in the URL — same shape as `inboxq.*`.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const calendarq = {
  'calendarq.status': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/calendarq/status`,
    tags: ['live-safe'],
  },
  'calendarq.layers': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/calendarq/layers`,
    tags: ['live-safe'],
  },
  'calendarq.agenda': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/calendarq/agenda`,
    tags: ['live-safe'],
  },
  'calendarq.coverage': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/calendarq/coverage`,
    tags: ['live-safe'],
  },
  'calendarq.changes': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/calendarq/changes`,
    tags: ['live-safe'],
  },
  'calendarq.sync': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/calendarq/sync`,
    tags: ['live-write'],
  },
  'calendarq.propose': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/calendarq/proposals`,
    tags: ['live-safe'],
  },
  'calendarq.proposals': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/calendarq/proposals`,
    tags: ['live-safe'],
  },
  'calendarq.reconcile': {
    method: 'POST',
    service: 'collector',
    path: ({ opId }) => `/api/v1/calendarq/reconcile/${encodeURIComponent(opId)}`,
    tags: ['live-write'],
  },
  'calendarq.receipts': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/calendarq/receipts`,
    tags: ['live-safe'],
  },
};
