/**
 * quoxBrain.js — P10.I-3 Quox Brain client service
 *
 * Fetches proactive suggestions from the server and dismisses them.
 * orgId is sourced from localStorage('current_org_id') per the
 * multi-tenant convention used across the codebase.
 *
 * Both functions accept an optional `authFetch` for authenticated requests.
 * When authFetch is not provided they fall back to the global fetch.
 */

const COLLECTOR_BASE = '/collector'

/**
 * Fetch the top-3 active suggestions for the current org.
 *
 * @param {object} opts
 * @param {string}   [opts.orgId]     - override org_id (defaults to localStorage)
 * @param {string}   [opts.tier]      - org tier (e.g. 'tier_b')
 * @param {Function} [opts.authFetch] - authenticated fetch (falls back to global fetch)
 * @returns {Promise<Array>} array of { id, score, payload }
 */
export async function getSuggestions({ orgId, tier = 'tier_free', authFetch } = {}) {
  const resolvedOrgId = orgId || localStorage.getItem('current_org_id') || ''
  const fetcher = authFetch || fetch

  const params = new URLSearchParams({ orgId: resolvedOrgId, tier })
  const url = `${COLLECTOR_BASE}/api/suggestions/list?${params}`

  try {
    const res = await fetcher(url)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data.suggestions) ? data.suggestions : []
  } catch {
    return []
  }
}

/**
 * Dismiss a suggestion for 7 days (org-level sticky).
 *
 * @param {object} opts
 * @param {string}   opts.suggestionId - rule id to dismiss
 * @param {string}   [opts.orgId]      - override org_id (defaults to localStorage)
 * @param {string}   [opts.userId]     - user making the dismissal
 * @param {Function} [opts.authFetch]  - authenticated fetch (falls back to global fetch)
 * @returns {Promise<{ ok: boolean }>}
 */
export async function dismissSuggestion({ suggestionId, orgId, userId = '', authFetch } = {}) {
  const resolvedOrgId = orgId || localStorage.getItem('current_org_id') || ''
  const fetcher = authFetch || fetch

  const url = `${COLLECTOR_BASE}/api/suggestions/dismiss`

  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: resolvedOrgId, userId, suggestionId }),
    })
    if (!res.ok) return { ok: false }
    return res.json()
  } catch {
    return { ok: false }
  }
}
