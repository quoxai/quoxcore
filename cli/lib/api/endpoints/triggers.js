/**
 * 'triggers.*' endpoints — WP2.2 (docs/STREAM_CLI_PARITY_PLAN.md §2.3 #2).
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * STEP 0 — quoxflow access path decision (documented here so future quoxflow
 * work packages don't have to re-derive it):
 *
 *   DIRECT to quoxflow (service: 'quoxflow'), NOT via the collector proxy.
 *
 *   Evidence:
 *   - services/collector/server.js proxies quoxflow ONLY on three explicit,
 *     hand-mounted paths: `GET /quoxflow/evidence`, `GET /quoxflow/observations`,
 *     `GET /quoxflow/skills[/:id]` (server.js ~19140-19260, "STUDY-REV P6.C —
 *     QuoxFlow evidence + observations proxy" / "CLI-COCKPIT — QuoxFlow
 *     skill-library (QSKL) read-only proxy"). Nothing forwards `/api/triggers/*`
 *     or `/api/workflows/:id/activate|deactivate` — grepping server.js for
 *     'quoxflow' turns up no catch-all proxy, only these three routes plus
 *     health-check plumbing. Fable's note that collector proxies are
 *     per-path explicit (not a wildcard) is confirmed live in this file.
 *   - quoxflow/src/api/app.ts mounts `createTriggersRoutes` at `app.route('/api/triggers', ...)`
 *     and `createWorkflowLifecycleRoutes` at `app.route('/api/workflows', ...)`
 *     (both confirmed by reading app.ts directly) — i.e. the real paths are
 *     `/api/triggers/webhooks|schedules|events` and
 *     `/api/workflows/:id/activate|deactivate`, neither proxied by collector.
 *   - quoxflow/src/api/middleware/auth.ts verifies the SAME JWT_SECRET as the
 *     QuoxCORE auth service, so a normal `quox login` bearer token is valid
 *     against quoxflow directly with zero extra auth plumbing.
 *   - cli/lib/commands/doctor.js already references `service: 'quoxflow',
 *     port: 3200` for its health check, establishing the service name — but
 *     cli/lib/core/config.js's SERVICE_PORTS never actually had a `quoxflow`
 *     key, so that health check silently resolved to the wrong URL (falls
 *     through to the base profile URL, unmodified port). Fixed alongside
 *     this fragment by adding `quoxflow: 3200` to SERVICE_PORTS, matching
 *     docker-compose.yml's `127.0.0.1:${QUOXFLOW_PORT:-3200}:3200` mapping.
 *
 *   Conclusion: direct is both the only reachable path AND now correctly
 *   wired (QUOX_QUOXFLOW_URL env override still available per the standard
 *   getServiceUrl() convention for non-docker-compose deployments).
 *
 * BACKEND FINDING (not fixed here — flagged for triage): none of
 * GET /api/triggers/webhooks, /schedules, or /events accept or filter by an
 * org/workflow scope — quoxflow/src/api/routes/triggers.ts calls
 * `config.webhookRegistry.getAll()` / `config.eventBus.getSubscriptions()`
 * unfiltered, returning every registered trigger across every org/workflow
 * on the instance. This is a cross-tenant read surface; the CLI commands
 * here pass the data through as-is (no client-side org filtering exists to
 * mask it) and this comment intentionally does not silently filter either,
 * since a client-side filter would hide the real gap instead of surfacing it.
 */

export const triggers = {
  'triggers.events': {
    method: 'GET',
    service: 'quoxflow',
    path: () => `/api/triggers/events`,
    tags: ['live-safe'],
  },
  'triggers.schedules': {
    method: 'GET',
    service: 'quoxflow',
    path: () => `/api/triggers/schedules`,
    tags: ['live-safe'],
  },
  'triggers.webhooks': {
    method: 'GET',
    service: 'quoxflow',
    path: () => `/api/triggers/webhooks`,
    tags: ['live-safe'],
  },
};
