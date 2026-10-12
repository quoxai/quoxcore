/**
 * VOLT Server API — thin fetch wrappers around collector VOLT endpoints.
 *
 * volt.db (via the collector) is the authoritative, tamper-evident source
 * of truth for VOLT evidence data. IndexedDB (volt-store.js) is an
 * offline cache ONLY — it must never be read as the primary source for
 * anything displayed as "evidence" in the UI. Callers should try these
 * server functions first and fall back to volt-store.js only when the
 * server is unreachable.
 */

const COLLECTOR_URL = '/collector'

async function voltFetch(path, { timeoutMs = 8000, ...opts } = {}) {
  const res = await fetch(`${COLLECTOR_URL}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    ...opts
  })
  if (!res.ok) throw new Error(`Server returned ${res.status}`)
  return res.json()
}

/**
 * Fetch VOLT stats (runs/events/bundles counts) from the server.
 * This is the authoritative count — never derive headline evidence
 * numbers from client-only counters (e.g. the in-session bridge stats).
 */
export async function fetchVoltStats() {
  return voltFetch('/volt/stats', { timeoutMs: 5000 })
}

/**
 * Fetch a page of VOLT runs from the server (full org history).
 */
export async function fetchVoltRuns(limit = 30, offset = 0) {
  return voltFetch(`/volt/runs?limit=${limit}&offset=${offset}`)
}

/**
 * Fetch the hash-chained events for a run from the server.
 */
export async function fetchVoltRunEvents(runId) {
  const data = await voltFetch(`/volt/runs/${encodeURIComponent(runId)}/events`)
  return data.events || []
}

/**
 * Fetch a previously-created evidence bundle for a run from the server.
 * Returns null (not throws) when no bundle exists yet — callers should
 * fall back to createVoltBundleOnServer().
 */
export async function fetchVoltBundle(runId) {
  try {
    const data = await voltFetch(`/volt/runs/${encodeURIComponent(runId)}/bundle`)
    return data.bundle?.data || null
  } catch {
    return null
  }
}

/**
 * Ask the server to assemble an evidence bundle from its own durable
 * event log (CRP-BE-4). This is what "tamper-evident" should mean —
 * the bundle is built from server-stored events, not client IndexedDB.
 */
export async function createVoltBundleOnServer(runId) {
  return voltFetch('/volt/bundles/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id: runId }),
    timeoutMs: 10000
  })
}
