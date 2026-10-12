/**
 * brain2FeedClient — Quox Qortex cockpit client (BRAIN2-PRODUCT Phase B).
 *
 * Talks to the collector's Feed API (services/collector/lib/feedApiHandlers.js)
 * over the standard `/collector/*` nginx proxy (mirrors grafanaClient.js /
 * nucleusMetrics.js — `/collector/api/v1/...` — feed routes are mounted at
 * collector-root `/api/feed/*`, so the browser path is `/collector/api/feed/*`).
 *
 * Auth: every call takes the caller's `authFetch` (from useAuth()) — the
 * JWT it attaches carries `req.user.org_id`, which the handlers use to scope
 * every read/write to the caller's own org. No org_id needs to be passed
 * from the frontend for a real user session (see feedApiHandlers.js
 * resolveOrgId()).
 *
 * Every function throws on a non-2xx response so callers can render an
 * honest error state instead of fabricating data (no localStorage fallback —
 * this is server-authoritative registry data).
 */

const PROXY_BASE = '/collector/api/feed';

async function handleResponse(resp) {
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body?.error?.message || body?.error || body?.message || `Request failed: HTTP ${resp.status}`);
    }
    return resp.json();
}

/**
 * GET /api/feed/sources — the source catalog merged with this org's
 * `feed_sources` rows.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch — authenticated fetch (from useAuth())
 * @returns {Promise<Array>} sources
 */
export async function getSources({ authFetch } = {}) {
    const json = await handleResponse(await authFetch(`${PROXY_BASE}/sources`));
    return json.sources || [];
}

/**
 * PUT /api/feed/sources/:sourceType — body { enabled?, scope?, config? }.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch
 * @param {string} sourceType
 * @param {object} patch — any subset of { enabled, scope, config }
 * @returns {Promise<object>} the updated source entry
 */
export async function putSource({ authFetch } = {}, sourceType, patch = {}) {
    const json = await handleResponse(await authFetch(`${PROXY_BASE}/sources/${encodeURIComponent(sourceType)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    }));
    return json.source;
}

/**
 * GET /api/feed/status — per-source last_sync/last_status/last_count plus
 * org totals (notes, connected).
 *
 * @param {object} opts
 * @param {Function} opts.authFetch
 * @returns {Promise<{sources: Array, totals: {notes: number, connected: number}}>}
 */
export async function getStatus({ authFetch } = {}) {
    return handleResponse(await authFetch(`${PROXY_BASE}/status`));
}

/**
 * GET /api/orgs/:orgId/connect/providers — auth service (BRAIN2-OAUTH-NOTION),
 * NOT the collector (note: no `/collector` prefix, unlike every other
 * function above). Which OAuth-connect providers exist and whether THIS
 * deployment has an OAuth app configured for them — no client id, no
 * secrets, just enough for the connect modal to tell "not provisioned yet"
 * from "connectable" apart.
 *
 * @param {string} orgId
 * @param {Function} authFetch
 * @returns {Promise<Array<{provider: string, configured: boolean}>>}
 */
export async function getConnectProviders(orgId, authFetch) {
    const resp = await authFetch(`/api/orgs/${encodeURIComponent(orgId)}/connect/providers`);
    const json = await handleResponse(resp);
    return json.providers || [];
}

/**
 * Builds the URL for GET /api/orgs/:orgId/connect/:provider/start — a
 * full-page 302 redirect flow, not a JSON API call. The caller navigates
 * the BROWSER here directly (`window.location.href = ...`); the browser's
 * own auth cookie carries the session to the auth service, which then
 * redirects on to the provider's own authorize page.
 *
 * @param {string} orgId
 * @param {string} provider - e.g. 'notion'
 * @param {string} [redirectTo] - where to land back in the app after connect
 * @returns {string}
 */
export function connectStartUrl(orgId, provider, redirectTo) {
    const params = new URLSearchParams();
    if (redirectTo) params.set('redirect_to', redirectTo);
    const qs = params.toString();
    return `/api/orgs/${encodeURIComponent(orgId)}/connect/${encodeURIComponent(provider)}/start${qs ? `?${qs}` : ''}`;
}
