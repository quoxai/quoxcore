/**
 * 'executions.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * fleet #465: quoxflow-direct GET routes for execution records
 * (quoxflow/src/api/routes/executions.ts, mounted at
 * app.route('/api/executions', ...)). These are the engine's OWN execution
 * store — a different backend from the auth-service 'runs.*' entries
 * (runs.js), which quoxflow never writes to. `quox run get`/`run list` use
 * these as the engine-first read, falling back to 'runs.get'/'runs.list' on
 * the auth-service model. Same access-path precedent as
 * 'workflows.activate'/'workflows.applyGet' in workflows.js: org_id is
 * resolved server-side from the caller's JWT/service-key context
 * (org-scope.ts, resolveOrgScope), never a URL/query param, so no orgId
 * path param appears here.
 */

export const executions = {
  'executions.get': {
    method: 'GET',
    service: 'quoxflow',
    path: ({ executionId }) => `/api/executions/${executionId}`,
    tags: ['live-safe'],
  },
  'executions.list': {
    method: 'GET',
    service: 'quoxflow',
    path: () => `/api/executions`,
    tags: ['live-safe'],
  },
  // #997: `run cancel`/`run resume` reach the engine first (these are the runs `run list` shows)
  'executions.cancel': {
    method: 'POST',
    service: 'quoxflow',
    path: ({ executionId }) => `/api/executions/${executionId}/cancel`,
    tags: ['live-write'],
  },
  'executions.resume': {
    method: 'POST',
    service: 'quoxflow',
    path: ({ executionId }) => `/api/executions/${executionId}/resume`,
    tags: ['live-write'],
  },
};
