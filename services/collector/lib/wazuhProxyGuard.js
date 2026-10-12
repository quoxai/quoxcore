/**
 * Wazuh Proxy Guard
 *
 * Security fix, STREAM WAZ v2 GAP 2 (docs/STREAM_WAZ_PLAN_V2.md section 4.1
 * lists GAP 1; this guard is the doc's GAP 2 companion fix, same failure
 * class): POST /api/v1/wazuh/proxy (server.js) took `endpoint` and `method`
 * straight from req.body with no allowlist. Past the auth gate, ANY
 * authenticated caller could drive the collector's Wazuh proxy against any
 * REST path on the manager with any HTTP method (agents PUT/DELETE, manager
 * config changes, etc.) — bypassing the dedicated HITL-gated routes
 * (deploy-agent, deploy-bulk, active-response, DELETE /agents/:agentId)
 * entirely, since the generic proxy has none of their approval gating.
 *
 * Mirrors this file's sibling, lib/routerosProxyGuard.js (WEB-REFACTOR note
 * #2289): the caller may only choose FROM an explicit allowlist of REST
 * path + method pairs. Built from the real call sites in
 * src/services/wazuhClient.js's `wazuhFetch()` (the function that actually
 * routes through this proxy — several other wazuhClient functions, e.g.
 * getAgents/getAlerts/getVulnerabilities/getManagerStatus, call their own
 * DEDICATED collector routes directly and never touch this proxy at all).
 *
 * Scoped to READ-ONLY (GET) requests deliberately: every destructive Wazuh
 * operation this collector supports (agent deploy/bulk-deploy/remove,
 * active-response) already has its own dedicated, HITL-gated route — none
 * of them go through this generic proxy. wazuhFetch() also exposes
 * register-agent (POST /agents), remove-agent (DELETE /agents/:id),
 * trigger-syscheck-scan (PUT /syscheck/:id) and alerts/summary (POST) as
 * generic-proxy calls, but grep across src/components/wazuh/ finds zero UI
 * call sites for any of them today — allowlisting them would only widen the
 * authenticated-SSRF surface this guard exists to close, for a capability
 * nothing currently uses. If a future feature needs one of those, add it to
 * the allowlist explicitly in the same commit that wires up the caller (or
 * give it a dedicated HITL route if it should be approval-gated).
 *
 * No egress/host guard needed here (unlike routerosProxyGuard's
 * assertRouterosEgressHost): the Wazuh host/port are resolved server-side
 * from vault/env config by getWazuhToken(orgId) in server.js — never from
 * the request body — so there is no caller-supplied host to validate. The
 * only caller-supplied inputs to this route are `endpoint` and `method`,
 * which is exactly what this allowlist constrains.
 */

// Wazuh numeric/alnum resource IDs (agent IDs, SCA policy IDs). Wazuh agent
// IDs are zero-padded numeric strings (e.g. "000", "001"); SCA policy IDs
// are short alnum/dash/underscore slugs. One shared, generously-bounded
// pattern covers both without being so loose it accepts path traversal.
const WAZUH_ID = '[0-9A-Za-z_-]{1,64}';

// Every REST path + method src/services/wazuhClient.js's wazuhFetch() sends
// through the proxy that is (a) read-only and (b) has a real caller today.
// Anything not on this list is rejected with 403 before the stored Wazuh
// credentials are ever attached to an outbound request. Query strings
// (getManagerLogs / getSyscheck append `?limit=...` etc.) are stripped
// before matching — see isAllowedWazuhRequest below.
const ALLOWED_WAZUH_REQUESTS = [
  { method: 'GET', pattern: /^\/manager\/info$/ },
  { method: 'GET', pattern: /^\/manager\/stats$/ },
  { method: 'GET', pattern: /^\/manager\/logs$/ },
  { method: 'GET', pattern: new RegExp(`^/agents/${WAZUH_ID}$`) },
  { method: 'GET', pattern: new RegExp(`^/agents/${WAZUH_ID}/key$`) },
  { method: 'GET', pattern: new RegExp(`^/syscheck/${WAZUH_ID}$`) },
  { method: 'GET', pattern: new RegExp(`^/sca/${WAZUH_ID}$`) },
  { method: 'GET', pattern: new RegExp(`^/sca/${WAZUH_ID}/checks/${WAZUH_ID}$`) },
];

/**
 * @param {string} method
 * @param {string} endpoint - raw `endpoint` field from the proxy request body
 * @returns {boolean}
 */
function isAllowedWazuhRequest(method, endpoint) {
  if (typeof method !== 'string' || typeof endpoint !== 'string' || !endpoint) return false;
  // wazuhClient.js's wazuhFetch() always sends a leading-slash path — a bare
  // relative string is not a real call site and is rejected outright
  // (defence in depth, mirrors routerosProxyGuard.js's identical check).
  if (!endpoint.startsWith('/')) return false;
  const path = endpoint;
  if (path.includes('..') || path.includes('\\') || path.includes('\0') || path.includes('#')) return false;

  // Strip a query string (allowed on manager/logs + syscheck/:id — see
  // module doc comment) before pattern matching; the pattern only ever
  // constrains method + path, never query content.
  const queryIdx = path.indexOf('?');
  const bare = queryIdx === -1 ? path : path.slice(0, queryIdx);

  const upperMethod = method.toUpperCase();
  return ALLOWED_WAZUH_REQUESTS.some(
    (entry) => entry.method === upperMethod && entry.pattern.test(bare)
  );
}

module.exports = {
  ALLOWED_WAZUH_REQUESTS,
  isAllowedWazuhRequest,
};
