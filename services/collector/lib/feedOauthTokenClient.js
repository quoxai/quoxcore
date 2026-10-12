/**
 * feedOauthTokenClient.js — collector-side OAuth token-broker client for
 * Qortex's OAuth-connected sources (Notion today; other providers register
 * the same way — see services/auth/config/oauthConnectProviders.js).
 *
 * The collector never decrypts a credential itself and never holds a
 * refresh token or an OAuth client secret. It calls the auth service's
 * POST /api/internal/oauth/:provider/access-token broker route
 * (services/auth/routes/oauth-connect.js), authenticated the same way
 * brainFeedClient.js authenticates to the brain: a shared
 * INTERNAL_SERVICE_KEY header, nothing else.
 *
 * Best-effort contract, mirroring brainFeedClient.js exactly: every call
 * catches its own errors and returns null instead of throwing. A null
 * token means "no access token, reconnect required" to every caller — the
 * auth service being down, the credential having been revoked or deleted,
 * the provider's OAuth app not being configured, or INTERNAL_SERVICE_KEY
 * being unset all collapse to the same inert result here. This is the
 * single choke point that keeps an OAuth-connected ingester honest: no
 * ingester using this client can ever read anything without a real,
 * live-decrypted token from the vault.
 */

'use strict';

const AUTH_BASE_URL = (
  process.env.AUTH_SERVICE_URL ||
  `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`
).replace(/\/$/, '');
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

/**
 * Resolves a short-lived access token for a connected OAuth credential.
 * Never throws.
 *
 * @param {string} orgId
 * @param {string} provider - e.g. 'notion'
 * @param {string} credentialId - the integrations-vault credential id (feed_sources.config.credentialId)
 * @param {{fetchImpl?: Function, signal?: AbortSignal}} [opts]
 * @returns {Promise<string|null>} the access token, or null on any failure/absence
 */
async function getAccessToken(orgId, provider, credentialId, { fetchImpl = fetch, signal } = {}) {
  if (!credentialId) return null;

  if (!SERVICE_KEY) {
    console.error(`[FeedOauthTokenClient] org=${orgId} provider=${provider}: INTERNAL_SERVICE_KEY not configured — inert`);
    return null;
  }

  try {
    const res = await fetchImpl(`${AUTH_BASE_URL}/api/internal/oauth/${encodeURIComponent(provider)}/access-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
      body: JSON.stringify({ credential_id: credentialId, org_id: orgId }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      console.error(`[FeedOauthTokenClient] org=${orgId} provider=${provider}: token broker HTTP ${res.status}`);
      return null;
    }
    const body = await res.json().catch(() => null);
    return body?.access_token || null;
  } catch (err) {
    console.error(`[FeedOauthTokenClient] org=${orgId} provider=${provider}: token broker unreachable — ${err.message}`);
    return null;
  }
}

module.exports = { getAccessToken };
