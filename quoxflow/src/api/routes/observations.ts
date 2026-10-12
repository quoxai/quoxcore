/**
 * Observations API Routes — STUDY-REV P6.C
 *
 * GET /api/observations?taskId=...&correlationId=...&workflowId=...&orgId=...
 *  → { observations: [...], meta: { count, requestId, timestamp } }
 *
 * Mounted in app.ts next to /api/evidence when observationStore is configured.
 * orgId scoping: QF-MT WP7 — org resolution is mandatory (JWT/service-key/
 * dev-fallback via src/api/middleware/org-scope.ts), not an optional filter.
 * Priority for index selection: correlationId > taskId > workflowId > full scan.
 *
 * The no-filter full-scan path uses duck-typing to walk the in-memory Map for
 * dev/test. In production (Postgres) callers MUST provide at least one filter.
 */

import { Hono, Context } from 'hono';
import { ObservationStore, ObservationRecord, ObservationOrgScope } from '../../store/observation-store.js';
import { AppEnv } from '../types.js';
import { resolveOrgScope, SYSTEM_SCOPE, OrgScope } from '../middleware/org-scope.js';

/** Translate the resolved caller OrgScope into the `string | SYSTEM_SCOPE`
 * shape ObservationStore methods expect (QF-MT WP7). */
function toStoreScope(scope: OrgScope): ObservationOrgScope {
  return scope.kind === 'system' ? SYSTEM_SCOPE : scope.orgId;
}

// Extend AppEnv with the observationStore variable local to this module.
type ObsEnv = AppEnv & { Variables: AppEnv['Variables'] & { observationStore: ObservationStore } };

const app = new Hono<ObsEnv>();

// ============================================================================
// GET /api/observations
// ============================================================================

app.get('/', async (c) => {
  const requestId = c.get('correlationId');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store: ObservationStore = (c as any).get('observationStore');

  const taskId = c.req.query('taskId');
  const correlationId = c.req.query('correlationId');
  const workflowId = c.req.query('workflowId');

  // QF-MT WP7: org resolution now goes through the shared org-scope helper —
  // JWT/service-key/dev-fallback semantics identical to the rest of the API
  // (see src/api/middleware/org-scope.ts). Previously org resolution here was
  // bespoke and the resulting filter was applied only `if (orgId)` was
  // truthy — a service-key caller with no X-Org-Id header (or any caller
  // where resolution came back empty) got every org's observations. Both the
  // store-level filter (fetchByBestIndex) and the unconditional route-level
  // backstop below now always apply.
  // ObsEnv is AppEnv + one extra Variable; Hono's Context is invariant in its
  // Variables generic so a structural-superset cast is needed here.
  const scope = resolveOrgScope(c as unknown as Context<AppEnv>);
  const storeScope = toStoreScope(scope);

  let records = await fetchByBestIndex(store, { taskId, correlationId, workflowId }, storeScope);

  // Backstop for the no-filter full-scan path: getAllObservations() reads the
  // in-memory Map directly (duck-typing), bypassing the store methods' own
  // scope filter above. Unconditional now — SYSTEM_SCOPE (service key, no
  // X-Org-Id) intentionally sees everything; a real org never does.
  if (scope.kind === 'org') {
    records = records.filter((r: ObservationRecord) => r.orgId === scope.orgId);
  }

  return c.json({
    observations: records,
    meta: {
      count: records.length,
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Pick the most specific index method and post-filter in memory for
 * secondary fields (the store only has single-field index methods).
 */
async function fetchByBestIndex(
  store: ObservationStore,
  filter: { taskId?: string; correlationId?: string; workflowId?: string },
  scope: ObservationOrgScope
): Promise<ObservationRecord[]> {
  const { taskId, correlationId, workflowId } = filter;

  if (correlationId) {
    let rows = await store.queryByCorrelation(correlationId, scope);
    if (taskId) rows = rows.filter(r => r.taskId === taskId);
    if (workflowId) rows = rows.filter(r => r.workflowId === workflowId);
    return rows;
  }

  if (taskId) {
    let rows = await store.queryByTask(taskId, scope);
    if (workflowId) rows = rows.filter(r => r.workflowId === workflowId);
    return rows;
  }

  if (workflowId) {
    return store.queryByWorkflow(workflowId, scope);
  }

  // No filter: full scan. In-memory store exposes its Map via the private
  // `inMemory` field (stripped to plain property at JS runtime). Postgres path
  // returns [] — callers should always provide a filter in production. The
  // route-level backstop above applies the org filter to this path.
  return getAllObservations(store);
}

/**
 * Return all observations for the no-filter path.
 * Works for the in-memory store (dev/test) via duck-typing.
 * Returns [] for Postgres (no queryAll API; callers must filter).
 */
async function getAllObservations(store: ObservationStore): Promise<ObservationRecord[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = store as any;
  if (s.inMemory instanceof Map) {
    return Array.from<ObservationRecord>(s.inMemory.values()).sort(
      (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
    );
  }
  return [];
}

export { app as observationRoutes };
