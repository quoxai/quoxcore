/**
 * Proxmox Credential Resolution (pure)
 *
 * VAULT-INTEG P3: the Unified Monitoring Config's `proxmox` health-check
 * entry (server.js MONITORING_DEFAULTS) read PROXMOX_URL / PROXMOX_API_TOKEN
 * from env directly, even though the org vault has a registered `proxmox`
 * integration type (services/auth/config/integrationTypeRegistry.js: fields
 * base_url/token_id/token_secret — HYPERION/'atlas', the Proxmox specialist
 * agent, is the natural agent-scope owner, mirroring wazuhCredentials.js's
 * 'argus' pattern for the Wazuh SIEM specialist).
 *
 * The Proxmox REST API expects the two token halves combined into a single
 * `PVEAPIToken=user@pam!tokenname=secret` header value (see server.js's
 * existing `Authorization: PVEAPIToken=${apiToken}` call sites) — this
 * module does that combining so callers get the same flat `token` string the
 * env fallback (PROXMOX_API_TOKEN) already provides pre-combined.
 */

/**
 * @param {object|null} resolved - result of resolveCredentialForAgent(orgId, 'atlas', 'proxmox'):
 *   { credentials: { base_url, token_id, token_secret }, source, ... } | { leaseBlocked, leaseReason } | null
 * @param {object} [env] - process.env (injected for testability), defaults to process.env
 * @returns {{ url: string, token: string }}
 * @throws {Error} with `.leaseBlocked = true` when the org's lease-enforcement
 *   mode blocks this agent from the credential (no fallback to env in that
 *   case — mirrors resolveWazuhConnection()'s rule).
 */
function resolveProxmoxConnection(resolved, env = process.env) {
  if (resolved && resolved.leaseBlocked) {
    const err = new Error(`Proxmox credential lease required: ${resolved.leaseReason || 'lease_required'}`);
    err.leaseBlocked = true;
    err.leaseReason = resolved.leaseReason || 'lease_required';
    throw err;
  }

  let url, token;

  const creds = resolved && resolved.credentials;
  if (creds && creds.base_url && creds.token_id && creds.token_secret) {
    url = creds.base_url;
    token = `${creds.token_id}=${creds.token_secret}`;
  }

  // Env vars are the LAST fallback — PROXMOX_API_TOKEN is already the
  // combined `token_id=token_secret` string, matching the vault's combined
  // shape above.
  if (!url) url = env.PROXMOX_URL || '';
  if (!token) token = env.PROXMOX_API_TOKEN || '';

  return { url, token };
}

module.exports = { resolveProxmoxConnection };
