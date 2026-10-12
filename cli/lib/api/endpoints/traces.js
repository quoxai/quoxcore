/**
 * 'traces.*' endpoints — TRV (Trace Replay & Visualization) API, added as
 * part of WP4.1 (STREAM_CLI_PARITY_PLAN.md §2.3 #8).
 *
 * Backend: services/collector/server.js, mounted at plain `/traces` (NOT
 * org-scoped in the URL — collector-direct, same pattern as aee.js/chat.js).
 * Verified at the handlers (server.js:11718-12348).
 *
 * ORG-SCOPING FINDING (backend, not fixed here — feeds the multi-tenant
 * audit): none of the three list reads below (traces.list, replaySessions.list,
 * comparisons.list, correlations.list) filter by org, despite the write side
 * accepting an optional `org_id` body field on create:
 *   - `GET /traces` queries the `envelopes` table, which has NO org_id
 *     column at all (see migrations/aee/000-baseline.sql) — every trace on
 *     the instance is returned regardless of caller.
 *   - `GET /traces/replay-sessions`, `GET /traces/comparisons`, and
 *     `GET /traces/correlations` all run a bare `SELECT * ... LIMIT ? OFFSET ?`
 *     with no `WHERE org_id = ?` (server.js:2014/2026/2037 prepared
 *     statements), even though `replay_sessions.org_id`, `trace_comparisons
 *     .org_id`, and `trace_correlations.org_id` columns exist WITH indexes
 *     built specifically for this (migrations/volt/000-baseline.sql:175-206)
 *     — org_id is stored on write but never used to filter on read. Same
 *     "leak" shape as the triggers.* / workflows.list findings documented in
 *     endpoints/triggers.js and endpoints/workflows.js. Not fixed here —
 *     out of scope for a CLI work package; flagging for the multi-tenant
 *     audit that requested this check.
 */

export const traces = {
  // ── Trace assembly (TRV-2) ──
  'traces.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/traces`,
    tags: ['live-safe'],
  },
  'traces.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/traces/${id}`,
    tags: ['live-safe'],
  },
  'traces.simulate': {
    method: 'POST',
    service: 'collector',
    path: ({ id }) => `/traces/${id}/simulate`,
    tags: ['live-write'],
  },
  'traces.compare': {
    method: 'POST',
    service: 'collector',
    path: () => `/traces/compare`,
    tags: ['live-write'],
  },

  // ── Replay sessions (TRV-1) ──
  'traces.replaySessions.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/traces/replay-sessions`,
    tags: ['live-write'],
  },
  'traces.replaySessions.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/traces/replay-sessions`,
    tags: ['live-safe'],
  },
  'traces.replaySessions.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/traces/replay-sessions/${id}`,
    tags: ['live-safe'],
  },
  'traces.replaySessions.update': {
    method: 'PUT',
    service: 'collector',
    path: ({ id }) => `/traces/replay-sessions/${id}`,
    tags: ['live-write'],
  },
  'traces.replaySessions.delete': {
    method: 'DELETE',
    service: 'collector',
    path: ({ id }) => `/traces/replay-sessions/${id}`,
    tags: ['live-write'],
  },
  'traces.replaySessions.deleteAll': {
    method: 'DELETE',
    service: 'collector',
    path: () => `/traces/replay-sessions`,
    tags: ['live-write'],
  },

  // ── Comparisons (TRV-1) ──
  'traces.comparisons.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/traces/comparisons`,
    tags: ['live-write'],
  },
  'traces.comparisons.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/traces/comparisons`,
    tags: ['live-safe'],
  },
  'traces.comparisons.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/traces/comparisons/${id}`,
    tags: ['live-safe'],
  },
  'traces.comparisons.update': {
    method: 'PUT',
    service: 'collector',
    path: ({ id }) => `/traces/comparisons/${id}`,
    tags: ['live-write'],
  },
  'traces.comparisons.delete': {
    method: 'DELETE',
    service: 'collector',
    path: ({ id }) => `/traces/comparisons/${id}`,
    tags: ['live-write'],
  },
  'traces.comparisons.deleteAll': {
    method: 'DELETE',
    service: 'collector',
    path: () => `/traces/comparisons`,
    tags: ['live-write'],
  },

  // ── Correlation cache (TRV-1) ──
  'traces.correlations.get': {
    method: 'GET',
    service: 'collector',
    path: ({ runId }) => `/traces/correlations/${runId}`,
    tags: ['live-safe'],
  },
  'traces.correlations.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/traces/correlations`,
    tags: ['live-write'],
  },
  'traces.correlations.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/traces/correlations`,
    tags: ['live-safe'],
  },
  'traces.correlations.delete': {
    method: 'DELETE',
    service: 'collector',
    path: ({ runId }) => `/traces/correlations/${runId}`,
    tags: ['live-write'],
  },
};
