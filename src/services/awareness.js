/**
 * awareness.js, QuoxAwareness client service
 *
 * Reads the awareness ledger summary (the same ledger the voice receptionist
 * reads) for the current org. Never throws: on any failure it returns an
 * empty summary flagged with `error: true`.
 *
 * Accepts an optional `authFetch` for authenticated requests; falls back to
 * the global fetch.
 */

const COLLECTOR_BASE = '/collector'

const EMPTY_SUMMARY = () => ({
  text: '',
  entries: [],
  counts: { total: 0, info: 0, warn: 0, critical: 0 },
  error: true,
})

/**
 * @param {object} opts
 * @param {string}   [opts.orgId]     - override org_id (defaults to localStorage)
 * @param {Function} [opts.authFetch] - authenticated fetch (falls back to global fetch)
 * @returns {Promise<{ text: string, entries: Array, counts: object, error?: boolean }>}
 */
export async function getAwarenessSummary({ orgId, authFetch } = {}) {
  const resolvedOrgId = orgId || localStorage.getItem('current_org_id') || ''
  const fetcher = authFetch || fetch

  const url = `${COLLECTOR_BASE}/api/v1/awareness/summary?org_id=${encodeURIComponent(resolvedOrgId)}`

  try {
    const res = await fetcher(url, {
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) return EMPTY_SUMMARY()
    return await res.json()
  } catch {
    return EMPTY_SUMMARY()
  }
}

/**
 * LUCID situation (read-only, does NOT advance the cursor).
 * Returns { ok: true, situation, text } or { ok: false, status, error }.
 * Never returns an empty situation on failure.
 */
export async function getLucidSituation({ authFetch } = {}) {
  const fetcher = authFetch || fetch
  try {
    const res = await fetcher(`${COLLECTOR_BASE}/api/v1/lucid/situation?surface=panel`, {
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    const body = await res.json()
    if (!body || !body.situation) return { ok: false, status: res.status, error: 'malformed response' }
    return { ok: true, situation: body.situation, text: body.text || '' }
  } catch (err) {
    return { ok: false, status: 0, error: (err && err.message) || 'network error' }
  }
}

/** Move the panel cursor to `seq`. Only call on explicit user action. */
export async function ackLucid(seq, { authFetch } = {}) {
  const fetcher = authFetch || fetch
  try {
    const res = await fetcher(`${COLLECTOR_BASE}/api/v1/lucid/ack?surface=panel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq }),
    })
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, status: res.status }
  } catch (err) {
    return { ok: false, status: 0, error: (err && err.message) || 'network error' }
  }
}

/** Duration formatter matching services/collector/lib/lucid/situation.js dur(). */
export function lucidDur(ms) {
  const v = Math.max(0, Number(ms) || 0)
  const m = Math.floor(v / 60000)
  if (m < 1) return `${Math.floor(v / 1000)}s`
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`
}
