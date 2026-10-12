/**
 * platformFlagsClient.js — Phase 25 (owner mandate 2026-08-06).
 *
 * Thin fetch wrapper around the collector's org-scoped settings API,
 * backing every Platform Flag control embedded in Settings (Privacy,
 * Execution Policy, QuoxMind, Qortex/Feed). Mirrors llmRoutingPolicyClient.js:
 * takes authFetch from useAuth() rather than handling credentials itself.
 *
 * GET  /collector/api/v1/platform/settings/flags
 * PATCH /collector/api/v1/platform/settings/flags/:key
 */

const BASE = '/collector/api/v1/platform/settings/flags'

/**
 * @param {Function} authFetch
 * @returns {Promise<Array>} every settable flag (boolean, or — VAULT-INTEG
 *   P14 slice 1 — string/number/enum) with effective value + source
 */
export async function fetchPlatformFlags(authFetch) {
  if (!authFetch) return []
  const response = await authFetch(BASE)
  if (!response.ok) {
    throw new Error(`Failed to load platform flags (${response.status})`)
  }
  const data = await response.json()
  return Array.isArray(data.flags) ? data.flags : []
}

/**
 * @param {Function} authFetch
 * @param {string} key
 * @param {boolean} on
 * @returns {Promise<object>} { ok, key, org_id, old_value, new_value, effective }
 */
export async function setPlatformFlag(authFetch, key, on) {
  return setPlatformSetting(authFetch, key, on ? 'true' : 'false')
}

/**
 * VAULT-INTEG P14 slice 1: the typed-value sibling of setPlatformFlag —
 * takes the raw string value directly (a number/enum/string entry's shape,
 * not a boolean) rather than assuming true/false. Same endpoint; the
 * collector's setOrgSetting() validates against the entry's declared type.
 *
 * @param {Function} authFetch
 * @param {string} key
 * @param {string} value
 * @returns {Promise<object>} { ok, key, org_id, old_value, new_value, effective }
 */
export async function setPlatformSetting(authFetch, key, value) {
  if (!authFetch) throw new Error('not authenticated')
  const response = await authFetch(`${BASE}/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Failed to update ${key} (${response.status})`)
  }
  return data
}
