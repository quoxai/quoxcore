/**
 * enforcementClient.js — LICENSE-LAUNCH LL-6b piece 4.
 *
 * Thin fetch wrapper around the auth service's enforcement posture API,
 * backing EnforcementPanel in Settings → Security. Mirrors
 * platformFlagsClient.js: takes authFetch from useAuth() rather than handling
 * credentials itself.
 *
 * GET    /api/setup/enforcement                       read posture (any member)
 * POST   /api/setup/enforcement/break-glass           open a window (instance admin)
 * DELETE /api/setup/enforcement/break-glass/:flag     close it (instance admin)
 */

const BASE = '/api/setup/enforcement'

/**
 * @param {Function} authFetch
 * @returns {Promise<{flags: Array, maxBreakGlassHours: number, nodeEnv: string}>}
 */
export async function fetchEnforcement(authFetch) {
  if (!authFetch) return { flags: [], maxBreakGlassHours: 72, nodeEnv: 'unknown' }
  const response = await authFetch(BASE)
  if (!response.ok) {
    throw new Error(`Failed to load enforcement posture (${response.status})`)
  }
  const data = await response.json()
  return {
    flags: Array.isArray(data.flags) ? data.flags : [],
    maxBreakGlassHours: data.max_break_glass_hours ?? 72,
    nodeEnv: data.node_env || 'unknown',
  }
}

/**
 * @param {Function} authFetch
 * @param {{flag: string, reason: string, hours: number}} input
 * @returns {Promise<object>} the created record
 */
export async function openBreakGlass(authFetch, { flag, reason, hours }) {
  if (!authFetch) throw new Error('not authenticated')
  const expiresAt = new Date(Date.now() + Number(hours) * 3600_000).toISOString()
  const response = await authFetch(`${BASE}/break-glass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flag, reason, expires_at: expiresAt }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.message || data.error || `Failed to open break-glass (${response.status})`)
  }
  return data.break_glass
}

/**
 * @param {Function} authFetch
 * @param {string} flag
 */
export async function clearBreakGlass(authFetch, flag) {
  if (!authFetch) throw new Error('not authenticated')
  const response = await authFetch(`${BASE}/break-glass/${encodeURIComponent(flag)}`, { method: 'DELETE' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.message || data.error || `Failed to clear break-glass (${response.status})`)
  }
  return data
}
