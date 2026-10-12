/**
 * 'mon.*' endpoints — monitoring queries, added as part of WP4.3
 * (STREAM_CLI_PARITY_PLAN.md §2.3 #10, the last item in the ranked top-10).
 *
 * Four backend surfaces, all `services/collector/server.js`, all
 * collector-direct (no org segment in the URL — same shape as
 * `traces.*`/`aee.*`):
 *
 *   - Docker fleet (`/docker/*`) — VERIFIED at the handlers (server.js
 *     ~7232-7401): these routes have NO auth middleware applied at all, and
 *     no org filtering — a bare fleet-wide scan/cache read across every
 *     Docker host the collector can reach. The CLI still sends a bearer
 *     (harmless) and still gates `quox mon docker *` behind
 *     `auth.requireAuth()` for a consistent logged-in CLI UX, but the
 *     backend itself would serve these to an unauthenticated caller.
 *   - Wazuh (`/api/v1/wazuh/*`) — gated by `requireServiceOrUserAuth()`.
 *     Reads (manager/status, agents, alerts, vulnerabilities,
 *     deploy-history) are not org-filtered by the Wazuh API itself (the org
 *     is only used to look up which Wazuh manager token to use); the writes
 *     (deploy-agent, deploy-bulk, active-response) are HITL-gated — they
 *     queue an HITL Inbox approval card and return 202, they do not execute
 *     immediately.
 *   - AGH-chain leaderboard (`/api/v1/agh-chain/*`) — gated by
 *     `requireServiceOrUserAuth()` AND org-scoped: the handler reads
 *     `req.user.org_id` and 403s with `{ error: 'org_id required' }` if
 *     absent (server.js:3007-3051). This is the one mon.* surface that is
 *     genuinely tenant-isolated server-side.
 *   - `/metrics` (Prometheus scrape) — NO auth middleware, plain text
 *     response (not JSON — `client.get()` returns `{ success: true, text }`
 *     for non-`application/json` content types).
 *   - Monitoring config/cache (`/api/v1/monitoring/*`) and Grafana config
 *     (`/api/v1/grafana/config`) — `monitoring.config` uses
 *     `requireAuth({ required: false })` (optional auth, works logged-out);
 *     `monitoring.cache.*` and `grafana.config` use
 *     `requireServiceOrUserAuth()` (auth required). None of the three are
 *     org-scoped — single shared config/cache per installation.
 */

export const mon = {
  'mon.agh-chain.leaderboard.events.list': {
    method: 'GET',
    service: 'collector',
    path: ({ agentId }) => `/api/v1/agh-chain/leaderboard/${agentId}/events`,
    tags: ['live-safe'],
  },
  'mon.agh-chain.leaderboard.get': {
    method: 'GET',
    service: 'collector',
    path: ({ agentId }) => `/api/v1/agh-chain/leaderboard/${agentId}`,
    tags: ['live-safe'],
  },
  'mon.agh-chain.leaderboard.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/agh-chain/leaderboard`,
    tags: ['live-safe'],
  },
  'mon.config.cache.get': {
    method: 'GET',
    service: 'collector',
    path: ({ service }) => `/api/v1/monitoring/cache/${service}`,
    tags: ['live-safe'],
  },
  'mon.config.get': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/monitoring/config`,
    tags: ['live-safe'],
  },
  'mon.config.grafana.get': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/grafana/config`,
    tags: ['live-safe'],
  },
  'mon.docker.containers.action': {
    method: 'POST',
    service: 'collector',
    path: ({ id, action }) => `/docker/containers/${id}/${action}`,
    tags: ['live-write'],
  },
  'mon.docker.containers.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/docker/containers/${id}`,
    tags: ['live-safe'],
  },
  'mon.docker.containers.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/docker/containers`,
    tags: ['live-safe'],
  },
  'mon.docker.containers.logs': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/docker/containers/${id}/logs`,
    tags: ['live-safe'],
  },
  'mon.docker.containers.stats': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/docker/containers/${id}/stats`,
    tags: ['live-safe'],
  },
  'mon.docker.fleet.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/docker/fleet`,
    tags: ['live-safe'],
  },
  'mon.docker.stacks.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/docker/stacks`,
    tags: ['live-safe'],
  },
  'mon.docker.system-df.get': {
    method: 'GET',
    service: 'collector',
    path: () => `/docker/system-df`,
    tags: ['live-safe'],
  },
  'mon.metrics.get': {
    method: 'GET',
    service: 'collector',
    path: () => `/metrics`,
    tags: ['live-safe'],
  },
  'mon.wazuh.active-response': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/wazuh/active-response`,
    tags: ['live-write'],
  },
  'mon.wazuh.agents.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/wazuh/agents`,
    tags: ['live-safe'],
  },
  'mon.wazuh.alerts.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/wazuh/alerts`,
    tags: ['live-safe'],
  },
  'mon.wazuh.deploy-agent': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/wazuh/deploy-agent`,
    tags: ['live-write'],
  },
  'mon.wazuh.deploy-bulk': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/wazuh/deploy-bulk`,
    tags: ['live-write'],
  },
  'mon.wazuh.deploy-history.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/wazuh/deploy-history`,
    tags: ['live-safe'],
  },
  'mon.wazuh.manager-status.get': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/wazuh/manager/status`,
    tags: ['live-safe'],
  },
  'mon.wazuh.vulnerabilities.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/wazuh/vulnerabilities`,
    tags: ['live-safe'],
  },
};
