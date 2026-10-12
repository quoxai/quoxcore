/**
 * 'brain.*' endpoints — Quox Qortex (services/quoxbrain, port 3106).
 * Mirrors the 'memory.*' fragment (./memory.js) convention. See
 * cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * Route confirmation (services/quoxbrain/server.js): brain.search.list is a
 * POST (not GET) — the route takes { query, limit, offset, ... } in the
 * request body, not a query string. Response shape: { results, tookMs }.
 */

export const brain = {
  'brain.note.get': {
    method: 'GET',
    service: 'quoxbrain',
    path: ({ id }) => `/notes/${id}`,
    tags: ['live-safe'],
  },
  'brain.search.list': {
    method: 'POST',
    service: 'quoxbrain',
    path: () => `/brain/search`,
    tags: ['live-safe'],
  },
  // ONE-BRAIN CX2: token-budgeted context pack. Body { query, tokenBudget? };
  // shape { passages, tokensUsed, insufficient, relevance, retrieval }.
  'brain.context.pack': {
    method: 'POST',
    service: 'quoxbrain',
    path: () => `/brain/context`,
    tags: ['live-safe'],
  },
  // BRAIN2-V3 A2: capture a note into the caller's NotesQ vault
  // (services/quoxbrain/lib/capture.js). Body { text?, title?, url?, tags? };
  // shape { noteId, status: created|updated|unchanged, title }.
  'brain.capture.create': {
    method: 'POST',
    service: 'quoxbrain',
    path: () => `/brain/capture`,
    tags: ['write'],
  },
  'brain.status.list': {
    method: 'GET',
    service: 'quoxbrain',
    path: () => `/brain/status`,
    tags: ['live-safe'],
  },
  // BRAIN2-AUDIT: the usage ledger (services/quoxbrain/server.js
  // GET /brain/usage, org-scoped by the authenticate middleware) — "is it
  // used?" as a visible number. Shape: { week, total, lastAgentQueryAt,
  // lastSearchAt }, each period carrying per-surface counts plus a
  // byExternalSource breakdown.
  'brain.usage.list': {
    method: 'GET',
    service: 'quoxbrain',
    path: () => `/brain/usage`,
    tags: ['live-safe'],
  },
  // BRAIN2-W13 A 118: durable per-turn citation records (GET /brain/citations?session=&limit=).
  'brain.citations.list': {
    method: 'GET',
    service: 'quoxbrain',
    path: () => `/brain/citations`,
    tags: ['live-safe'],
  },
  // ONE-BRAIN CX5: relevance judgements (the labelled eval set).
  'brain.judgements.create': {
    method: 'POST',
    service: 'quoxbrain',
    path: () => `/brain/judgements`,
    tags: ['write'],
  },
  'brain.judgements.list': {
    method: 'GET',
    service: 'quoxbrain',
    path: () => `/brain/judgements`,
    tags: ['live-safe'],
  },
  // ONE-BRAIN CX6: topic subscriptions ("tell my slot when new notes about X land").
  'brain.subscriptions.create': {
    method: 'POST',
    service: 'quoxbrain',
    path: () => `/brain/subscriptions`,
    tags: ['write'],
  },
  // ONE-BRAIN CX6: the Feed's source registry (collector feedApiHandlers.js).
  'brain.sources.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/feed/sources`,
    tags: ['live-safe'],
  },
  'brain.sources.update': {
    method: 'PUT',
    service: 'collector',
    path: ({ type }) => `/api/feed/sources/${encodeURIComponent(type)}`,
    tags: ['write'],
  },
  'brain.subscriptions.list': {
    method: 'GET',
    service: 'quoxbrain',
    path: () => `/brain/subscriptions`,
    tags: ['live-safe'],
  },
  'brain.subscriptions.delete': {
    method: 'DELETE',
    service: 'quoxbrain',
    path: ({ id }) => `/brain/subscriptions/${encodeURIComponent(id)}`,
    tags: ['write'],
  },
  // BRAIN2-AUDIT: "Ask Qortex" starter questions generated from the caller's
  // own corpus (services/quoxbrain/lib/suggestions.js, GET /brain/suggestions).
  // Shape: { suggestions:[{question,reason,source,noteId}], message?, generatedAt }.
  'brain.suggestions.list': {
    method: 'GET',
    service: 'quoxbrain',
    path: () => `/brain/suggestions`,
    tags: ['live-safe'],
  },
  // BRAIN2-V3 B3: daily brief (services/quoxbrain/lib/brief.js, GET /brain/brief?since=24h).
  'brain.brief.get': {
    method: 'GET',
    service: 'quoxbrain',
    path: () => `/brain/brief`,
    tags: ['live-safe'],
  },
  // BRAIN2-W8: portable export of the caller's visible notes (services/quoxbrain
  // GET /export). ?format=jsonl (default, application/x-ndjson) | markdown (tar).
  'brain.export.get': {
    method: 'GET',
    service: 'quoxbrain',
    path: () => `/export`,
    tags: ['live-safe'],
  },
  'brain.vaults.list': {
    method: 'GET',
    service: 'quoxbrain',
    path: () => `/vaults`,
    tags: ['live-safe'],
  },
};
