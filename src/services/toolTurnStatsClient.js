/**
 * QUOXHAT P0 — client for the per-turn tool manifest baseline.
 *
 * Reads GET /collector/api/v1/observability/tool-turns (org-scoped via the
 * caller's verified JWT; see services/collector/lib/turnToolStats.js). The
 * server is the source of truth; this client holds no cache. Shared by the
 * Settings execution-policy panel and the Mirror tool-load card so both
 * surfaces show the SAME numbers (the QuoxHat acceptance criterion is
 * agreement between what the Mirror shows and what the executor permits).
 */

const ENDPOINT = '/collector/api/v1/observability/tool-turns'

/**
 * @param {Function|null} authFetch AuthContext fetch (falls back to plain fetch)
 * @param {number} [limit=100]
 * @returns {Promise<{ok: boolean, entries: Array, agents: Object, error?: string}>}
 */
export async function fetchToolTurnStats(authFetch, limit = 100) {
  const doFetch = authFetch || fetch
  try {
    const resp = await doFetch(`${ENDPOINT}?limit=${encodeURIComponent(limit)}`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) {
      // An error body is not data — report the status, never an empty fleet.
      return { ok: false, entries: [], agents: {}, error: `HTTP ${resp.status}` }
    }
    const body = await resp.json()
    return {
      ok: body.ok === true,
      entries: Array.isArray(body.entries) ? body.entries : [],
      agents: body.agents && typeof body.agents === 'object' ? body.agents : {},
      error: body.ok === true ? undefined : (body.error || 'unknown'),
    }
  } catch (err) {
    return { ok: false, entries: [], agents: {}, error: err?.message || 'network_error' }
  }
}
