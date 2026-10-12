/**
 * 'workflows.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * WP2.5 (docs/STREAM_CLI_PARITY_PLAN.md §2.3 #5 — `quox workflow apply/validate/import`):
 * the 'workflows.apply*'/'workflows.importN8n'/'workflows.importObjective'/'workflows.validate'
 * entries below are DIRECT to quoxflow (service: 'quoxflow'), same access-path precedent as
 * 'workflows.activate'/'workflows.deactivate' above. They are DELIBERATELY separate keys from
 * 'workflows.create'/'workflows.update' (which hit the AUTH service's org-scoped, lightweight
 * workflows table used by the pre-existing `workflow create`/`workflow update` commands) — the
 * quoxflow store is a completely different backend (full Workflow/DAG execution schema, no
 * orgId in the path) and reusing the same key names would have silently overwritten the auth
 * entries in this object literal (no error — endpoints-fragments.test.js's duplicate-key guard
 * only checks ACROSS fragment files, not within one file's own object literal).
 *
 * Route provenance (quoxflow/src/api/routes/workflows.ts, mounted at app.route('/api/workflows', ...)):
 *   - applyCreate: POST /api/workflows — body validated by WorkflowSchema (core/workflow.ts),
 *     which requires `id` as a non-optional field — i.e. even "create" needs a caller-supplied
 *     id; the store's save() is an upsert (`ON CONFLICT (id) DO UPDATE`), so POSTing an id that
 *     already exists silently updates it instead of erroring.
 *   - applyGet: GET /api/workflows/:id — used internally by `workflow apply`'s diff-preview to
 *     fetch the current stored definition before a PUT.
 *   - applyUpdate: PUT /api/workflows/:id — partial merge (name/description/notes/definition, or
 *     top-level nodes/edges/variables/metadata/tags), NOT validated against WorkflowSchema.
 *   - validate: POST /api/workflows/:id/validate — validates the ALREADY-STORED workflow by id;
 *     takes no body at all (no validateBody on this route). It does NOT validate arbitrary local
 *     file content — only whatever is currently persisted under that id.
 *   - importN8n: POST /api/workflows/import-n8n — body { workflow: unknown, options?: { generateIds?, includePositions? } }.
 *   - importObjective: POST /api/workflows/import-objective — body { template: {...}, schedule?: { cron, timezone? }, options?: { activate?, includeApprovalGate? } }.
 *
 * BACKEND FINDING (not fixed here — flagged for triage, see also the identical finding
 * documented in endpoints/triggers.js): GET /api/workflows (list, quoxflow) does NOT filter by
 * org at all — `createWorkflowRoutes`'s `app.get('/', ...)` calls `deps.workflowStore.list({
 * limit, offset, active })` with no orgId, and neither `InMemoryWorkflowStore.list()` nor
 * `PostgresWorkflowStore.list()` (workflow-store.ts) accept or filter on one — `ListOptions`
 * has no orgId field. Worse than triggers.*: `PostgresWorkflowStore.save()` doesn't even INSERT
 * an org_id value (relies on the column's DB-level `DEFAULT 'default'`), so every workflow
 * created via this quoxflow-direct path is invisible to any per-org filtering that might be
 * bolted on later unless a migration backfills it. Same cross-tenant-leak shape as the
 * triggers.* finding — every org's workflows are visible to every other org's caller via this
 * endpoint today. Not seeded as a CLI endpoint in this file (no CLI command reads it), so it
 * isn't reachable via `quox workflow ...` — flagged here purely because WP2.5 was asked to
 * check it while reading this route file for the apply/validate/import work.
 */

export const workflows = {
  // WP2.2: lifecycle routes live in QUOXFLOW (not auth), unlike every other
  // 'workflows.*' entry in this file. quoxflow/src/api/routes/workflows-lifecycle.ts
  // mounts at /api/workflows (app.ts), registering/unregistering triggers on
  // activate/deactivate. org_id travels in the body (optional tenant-ownership
  // check — see route handler), NOT the URL, so no orgId path param here.
  'workflows.activate': {
    method: 'POST',
    service: 'quoxflow',
    path: ({ workflowId }) => `/api/workflows/${workflowId}/activate`,
    tags: ['live-write'],
  },
  'workflows.applyCreate': {
    method: 'POST',
    service: 'quoxflow',
    path: () => `/api/workflows`,
    tags: ['live-write'],
  },
  'workflows.applyGet': {
    method: 'GET',
    service: 'quoxflow',
    path: ({ workflowId }) => `/api/workflows/${workflowId}`,
    tags: ['live-safe'],
  },
  // fleet #465: GET /api/workflows (list), same quoxflow-direct precedent as
  // 'workflows.applyGet' above. Added so `workflow list` can read the engine
  // store's own list route instead of only the auth-service store, which
  // quoxflow's write paths (activate/applyCreate/applyUpdate) never touch.
  'workflows.applyList': {
    method: 'GET',
    service: 'quoxflow',
    path: () => `/api/workflows`,
    tags: ['live-safe'],
  },
  // quoxflow#7: execute an engine-store workflow directly (the auth-service
  // runs route only knows auth-store workflows). Org comes from the caller's
  // auth context server-side, like the other quoxflow-direct entries.
  'workflows.applyExecute': {
    method: 'POST',
    service: 'quoxflow',
    path: ({ workflowId }) => `/api/workflows/${workflowId}/execute`,
    tags: ['live-write'],
  },
  'workflows.applyUpdate': {
    method: 'PUT',
    service: 'quoxflow',
    path: ({ workflowId }) => `/api/workflows/${workflowId}`,
    tags: ['live-write'],
  },
  'workflows.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/workflows`,
    tags: ['live-write'],
  },
  'workflows.deactivate': {
    method: 'POST',
    service: 'quoxflow',
    path: ({ workflowId }) => `/api/workflows/${workflowId}/deactivate`,
    tags: ['live-write'],
  },
  'workflows.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, workflowId }) => `/api/orgs/${orgId}/workflows/${workflowId}`,
    tags: ['live-write'],
  },
  'workflows.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, workflowId }) => `/api/orgs/${orgId}/workflows/${workflowId}`,
    tags: ['live-safe'],
  },
  'workflows.importN8n': {
    method: 'POST',
    service: 'quoxflow',
    path: () => `/api/workflows/import-n8n`,
    tags: ['live-write'],
  },
  'workflows.importObjective': {
    method: 'POST',
    service: 'quoxflow',
    path: () => `/api/workflows/import-objective`,
    tags: ['live-write'],
  },
  'workflows.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/workflows`,
    tags: ['live-safe'],
  },
  'workflows.publish': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, workflowId }) => `/api/orgs/${orgId}/workflows/${workflowId}/publish`,
    tags: ['live-write'],
  },
  'workflows.steps': {
    method: 'PUT',
    service: 'auth',
    path: ({ orgId, workflowId }) => `/api/orgs/${orgId}/workflows/${workflowId}/steps`,
    tags: ['live-write'],
  },
  'workflows.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId, workflowId }) => `/api/orgs/${orgId}/workflows/${workflowId}`,
    tags: ['live-write'],
  },
  'workflows.validate': {
    method: 'POST',
    service: 'quoxflow',
    path: ({ workflowId }) => `/api/workflows/${workflowId}/validate`,
    tags: ['live-safe'],
  },
};
