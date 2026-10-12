/**
 * Grafana Credential Resolution (pure)
 *
 * VAULT-INTEG P3 — GRAFANA_API_KEY was a module-level const
 * (`process.env.GRAFANA_API_KEY`), read once at process start, structurally
 * single-tenant: every org sharing this collector got the SAME key. This
 * mirrors the extraction pattern of lib/wazuhCredentials.js — the "vault
 * wins, env is the last resort" decision lives here (pure, no fetch), so it
 * is unit testable without booting the collector or hitting a real Grafana.
 *
 * The caller (agentTools.js's grafana_dashboards tool) resolves the org's
 * `grafana` vault credential via resolveCredentialForAgent(orgId, agentId,
 * 'grafana') and passes the result through resolveGrafanaApiKey() before
 * calling toolExecutors/grafana.js.
 */

/**
 * @param {object|null} resolved - result of resolveCredentialForAgent(orgId, agentId, 'grafana'):
 *   { credentials: { api_key, base_url }, source, ... } | { leaseBlocked, leaseReason } | null
 * @param {object} [env] - process.env (injected for testability), defaults to process.env
 * @returns {string} the resolved API key, or '' when neither source has one
 * @throws {Error} with `.leaseBlocked = true` when the org's lease-enforcement
 *   mode blocks this credential (no fallback to env in that case — a
 *   lease-blocked credential must not be silently bypassed by a looser
 *   env-var fallback).
 */
function resolveGrafanaApiKey(resolved, env = process.env) {
  if (resolved && resolved.leaseBlocked) {
    const err = new Error(`Grafana credential lease required: ${resolved.leaseReason || 'lease_required'}`);
    err.leaseBlocked = true;
    err.leaseReason = resolved.leaseReason || 'lease_required';
    throw err;
  }

  const creds = resolved && resolved.credentials;
  if (creds && creds.api_key) return creds.api_key;

  // Env var is the LAST fallback.
  return env.GRAFANA_API_KEY || '';
}

/**
 * Resolve the org's Grafana BASE URL, same "vault wins, env is last resort"
 * discipline as resolveGrafanaApiKey. This is the fix for the credential-
 * misdirection bug: without it, grafanaDashboards() sent every org's vault
 * api_key as a Bearer token to the single global GRAFANA_URL (the deploy's
 * default instance) instead of that org's own Grafana — transmitting one org's
 * token to another org's server. The vault `grafana` credential type carries
 * `base_url` (required, see integrationTypeRegistry.js); use it.
 *
 * Lease enforcement is handled by resolveGrafanaApiKey (called first at the
 * same call site), so this resolver stays pure and non-throwing.
 *
 * @param {object|null} resolved - result of resolveCredentialForAgent(...):
 *   { credentials: { api_key, base_url }, ... } | null
 * @param {object} [env] - process.env (injected for testability)
 * @returns {string} the resolved base URL, or '' when neither source has one
 */
function resolveGrafanaBaseUrl(resolved, env = process.env) {
  const creds = resolved && resolved.credentials;
  if (creds && creds.base_url) return creds.base_url;

  // Env var is the LAST fallback (the deploy-wide default embed URL).
  return env.GRAFANA_URL || '';
}

module.exports = { resolveGrafanaApiKey, resolveGrafanaBaseUrl };
