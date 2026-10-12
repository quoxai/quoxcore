/**
 * Wazuh Credential Resolution (pure)
 *
 * AGENT-OVERHAUL fix: getWazuhToken (server.js) used to call
 * resolveCredentials(orgId, ['wazuh']) as its "vault-first" branch. That
 * resolver flattens every provider to `{ key, source }` (services/auth
 * routes/setup.js POST /internal/resolve -> resolveProviderKey) and never
 * returns base_url/username/password, so the branch was permanently dead —
 * the WazuhSetupGate onboarding form's saved credentials were never read at
 * runtime, which only ever consulted WAZUH_HOST/WAZUH_API_PASSWORD env vars.
 *
 * Fix: getWazuhToken now resolves via resolveCredentialForAgent(orgId,
 * 'argus', 'wazuh') (services/collector/lib/agentTools.js), whose
 * `credentials` field carries the full decrypted multi-field object
 * ({ base_url, username, password }, the contract WazuhSetupGate/the auth
 * vault now save under). This module holds the pure "which host/user/
 * password wins" decision (vault first, env vars last) so it can be unit
 * tested without booting the collector or hitting a real Wazuh manager —
 * mirrors the extraction pattern of lib/wazuhProxyGuard.js.
 */

const BASE_URL_RE = /^https?:\/\/([^:/]+)(?::(\d+))?/;

/**
 * @param {object|null} resolved - result of resolveCredentialForAgent(orgId, 'argus', 'wazuh'):
 *   { credentials: { base_url, username, password }, source, ... } | { leaseBlocked, leaseReason } | null
 * @param {object} [env] - process.env (injected for testability), defaults to process.env
 * @returns {{ host: string, port: number, user: string, password: string }}
 * @throws {Error} with `.leaseBlocked = true` when the org's lease-enforcement
 *   mode blocks this agent from the credential (no fallback to env in that case
 *   — a lease-blocked credential must not be silently bypassed by a looser
 *   env-var fallback).
 * @throws {Error} when neither vault nor env resolves a host or a password.
 */
function resolveWazuhConnection(resolved, env = process.env) {
  if (resolved && resolved.leaseBlocked) {
    const err = new Error(`Wazuh credential lease required: ${resolved.leaseReason || 'lease_required'}`);
    err.leaseBlocked = true;
    err.leaseReason = resolved.leaseReason || 'lease_required';
    throw err;
  }

  let host, port, user, password;

  const creds = resolved && resolved.credentials;
  if (creds && creds.base_url && creds.password) {
    const m = String(creds.base_url).match(BASE_URL_RE);
    if (m) {
      host = m[1];
      port = m[2] || '55000';
    }
    user = creds.username || 'wazuh-wui';
    password = creds.password;
  }

  // Env vars are the LAST fallback — only used for whichever field the
  // vault didn't provide.
  if (!host) host = env.WAZUH_HOST || '';
  if (!port) port = env.WAZUH_API_PORT || '55000';
  if (!user) user = env.WAZUH_API_USER || 'wazuh-wui';
  if (!password) password = env.WAZUH_API_PASSWORD;

  if (!host) throw new Error('WAZUH_HOST env var or vault entry (base_url) is required');
  if (!password) throw new Error('WAZUH_API_PASSWORD env var or vault entry required');

  return { host, port: parseInt(port, 10), user, password };
}

/**
 * VAULT-INTEG P3: the two Wazuh Indexer (OpenSearch) query routes
 * (GET /api/v1/wazuh/alerts, GET /api/v1/wazuh/vulnerabilities) read
 * WAZUH_HOST / WAZUH_INDEXER_USER / WAZUH_INDEXER_PASSWORD from env directly,
 * even though the same org has a `wazuh` vault credential ({base_url,
 * username, password}) resolveWazuhConnection() above already uses for the
 * Manager API. There is no separate vault field for the Indexer's own
 * credentials (often a distinct OpenSearch admin account), so this resolves
 * the SAME vault credential vault-first for the indexer host, and only
 * consults env vars for whichever field the vault didn't provide — matching
 * resolveWazuhConnection()'s ordering, but keeping the indexer's own
 * conventional default ('admin', not 'wazuh-wui') when neither source has a
 * user, since the two credentials are conventionally distinct accounts.
 *
 * @param {object|null} resolved - result of resolveCredentialForAgent(orgId, 'argus', 'wazuh')
 * @param {object} [env] - process.env (injected for testability)
 * @returns {{ host: string, user: string, password: string }}
 * @throws {Error} with `.leaseBlocked = true` when the org's lease-enforcement
 *   mode blocks this agent from the credential (same rule as above — no
 *   fallback to env when leaseBlocked).
 */
function resolveWazuhIndexerConnection(resolved, env = process.env) {
  if (resolved && resolved.leaseBlocked) {
    const err = new Error(`Wazuh credential lease required: ${resolved.leaseReason || 'lease_required'}`);
    err.leaseBlocked = true;
    err.leaseReason = resolved.leaseReason || 'lease_required';
    throw err;
  }

  let host, user, password;

  const creds = resolved && resolved.credentials;
  if (creds && creds.base_url) {
    const m = String(creds.base_url).match(BASE_URL_RE);
    if (m) host = m[1];
  }
  if (creds && creds.username) user = creds.username;
  if (creds && creds.password) password = creds.password;

  // Env vars are the LAST fallback — only used for whichever field the
  // vault didn't provide. Default user stays 'admin' (the Indexer's
  // conventional default), not 'wazuh-wui' (the Manager API's default).
  if (!host) host = env.WAZUH_HOST || '';
  if (!user) user = env.WAZUH_INDEXER_USER || 'admin';
  if (!password) password = env.WAZUH_INDEXER_PASSWORD || '';

  return { host, user, password };
}

module.exports = { resolveWazuhConnection, resolveWazuhIndexerConnection };
