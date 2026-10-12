/**
 * lucid.js, LUCID v2 client service (contract: docs/LUCID_CONTRACT_v2.md)
 *
 * Every call returns { ok: true, ...payload } or { ok: false, status, error }.
 * Never returns an empty situation on failure: callers must render the error.
 * Pass `authFetch` (from useAuth) for authenticated requests.
 */

const BASE = '/collector/api/v1/lucid'

async function call(path, { method = 'GET', body, authFetch } = {}) {
  const fetcher = authFetch || fetch
  try {
    const res = await fetcher(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    let data = null
    try { data = await res.json() } catch { data = null }
    return { ok: true, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, error: (err && err.message) || 'network error' }
  }
}

function qs(params) {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  return p.length ? `?${p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : ''
}

/** Situation v2. `advance` moves the cursor server-side: leave false for display polling. */
export async function getSituation({ since, surface = 'panel', advance = false, authFetch } = {}) {
  const r = await call(`/situation${qs({ since, surface, advance: advance ? 'true' : undefined })}`, { authFetch })
  if (!r.ok) return r
  if (!r.data || !r.data.situation) return { ok: false, status: r.status, error: 'malformed response' }
  return { ok: true, situation: r.data.situation, text: r.data.text || '', spoken: r.data.spoken || '' }
}

export async function getItem(ref, { authFetch } = {}) {
  const r = await call(`/item${qs({ ref })}`, { authFetch })
  if (!r.ok) return r
  if (!r.data || !r.data.item) return { ok: false, status: r.status, error: 'malformed response' }
  return { ok: true, item: r.data.item }
}

/** Returns { ok, result: { status: 'filed'|'manual'|'opened', approval_id?, say?, command?, url? } } */
export async function runMeasure(ref, measureId, { authFetch } = {}) {
  const r = await call('/measure', { method: 'POST', body: { ref, measure_id: measureId }, authFetch })
  if (!r.ok) return r
  return { ok: true, result: r.data || {} }
}

export async function teach(lesson, { authFetch } = {}) {
  const r = await call('/teach', { method: 'POST', body: lesson, authFetch })
  return r.ok ? { ok: true, lesson: r.data } : r
}

export async function listLessons({ authFetch } = {}) {
  const r = await call('/lessons', { authFetch })
  if (!r.ok) return r
  const d = r.data
  return { ok: true, lessons: Array.isArray(d) ? d : (d && d.lessons) || [] }
}

export async function deleteLesson(id, { authFetch } = {}) {
  return call(`/lessons/${encodeURIComponent(id)}`, { method: 'DELETE', authFetch })
}

/** Move the cursor to `seq`. Only call on explicit user action ("Mark seen"). */
export async function ack(seq, { surface = 'panel', authFetch } = {}) {
  return call(`/ack${qs({ surface })}`, { method: 'POST', body: { seq }, authFetch })
}

/** What LUCID told the owner in a window (e.g. since='24h'). Returns { ok, told: [...] } oldest first as served. */
export async function getTold(since = '24h', { authFetch } = {}) {
  const r = await call(`/told${qs({ since })}`, { authFetch })
  if (!r.ok) return r
  if (!r.data || !Array.isArray(r.data.told)) return { ok: false, status: r.status, error: 'malformed response' }
  return { ok: true, told: r.data.told, counts: r.data.counts || {} }
}

/** Duration formatter matching the collector's dur(). */
export function dur(ms) {
  const v = Math.max(0, Number(ms) || 0)
  const m = Math.floor(v / 60000)
  if (m < 1) return `${Math.floor(v / 1000)}s`
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`
}

/** en-GB, Europe/London. */
export function fmtWhen(ms) {
  if (!ms) return ''
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms))
  } catch {
    return ''
  }
}
