/**
 * MON-GOV Phase 2: Governance Incidents API Client
 *
 * Thin wrapper over the /collector/governance/incidents REST endpoints
 * plus a WebSocket subscription helper that filters the unified
 * EventStreamHub output to governance.incident.* events.
 *
 * All requests carry `credentials: 'include'` so the auth-service JWT
 * cookie rides along. Responses are unwrapped from their top-level
 * envelope (`{ data, total }` for list, `{ incident }` for writes, etc.)
 * so callers work with plain objects.
 */

const BASE = '/collector/governance/incidents'

function buildQueryString(params) {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    qs.set(key, String(value))
  }
  const str = qs.toString()
  return str ? `?${str}` : ''
}

async function request(path, opts = {}) {
  const resp = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  })
  const contentType = resp.headers.get('content-type') || ''
  const body = contentType.includes('application/json') ? await resp.json() : null
  if (!resp.ok) {
    const err = new Error(body?.error || `${resp.status} ${resp.statusText}`)
    err.status = resp.status
    err.body = body
    throw err
  }
  return body
}

/**
 * GET /governance/incidents — paginated list.
 * Filters: { severity, status, incident_type, agent_id, corr, since, until, limit, offset }
 * Returns { data: Incident[], total: number }.
 */
export async function listIncidents(filters = {}) {
  return request(`${BASE}${buildQueryString(filters)}`)
}

/**
 * GET /governance/incidents/:id — detail + linked envelopes.
 * Returns { incident, envelopes: EnvelopeSummary[] }.
 */
export async function getIncident(id) {
  return request(`${BASE}/${encodeURIComponent(id)}`)
}

/**
 * PATCH /governance/incidents/:id — status / resolution / assigned_to / severity.
 * Returns { incident }.
 */
export async function updateIncident(id, patch) {
  return request(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

/**
 * POST /governance/incidents/:id/witness — emit witness envelope + stamp receipt.
 * Returns { incident }.
 */
export async function witnessIncident(id) {
  return request(`${BASE}/${encodeURIComponent(id)}/witness`, { method: 'POST' })
}

/**
 * POST /governance/incidents — manual incident (rare).
 * Returns { incident }.
 */
export async function createIncident(payload) {
  return request(BASE, { method: 'POST', body: JSON.stringify(payload) })
}

/**
 * GET /governance/baselines — Per-agent behavioural baseline summary.
 * Returns { data: Baseline[] }.
 */
export async function listBaselines() {
  return request('/collector/governance/baselines')
}

// ─────────────────────────────────────────────────────────────────────────
// Live updates via EventStreamHub
// ─────────────────────────────────────────────────────────────────────────

/**
 * Subscribe to live incident events. Opens a WebSocket against the
 * collector's unified event stream and invokes `onEvent(envelope)`
 * for each governance.incident.* envelope that arrives.
 *
 * Returns a disposer function that closes the socket.
 *
 * The caller is responsible for reconnection policy. In practice the
 * Incidents tab only holds the subscription while mounted, so a
 * full re-open on unmount/remount is acceptable.
 */
export function subscribeToIncidents(onEvent, options = {}) {
  const { layers = ['governance'], onStatus } = options

  let socket = null
  let closed = false

  try {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    // Unified EventStreamHub WebSocket — matches the collector's
    // eventStreamWss.handleUpgrade('/api/v1/stream/events', …) route.
    const url = `${proto}//${window.location.host}/collector/api/v1/stream/events?layers=${encodeURIComponent(layers.join(','))}`
    socket = new WebSocket(url)

    socket.onopen = () => onStatus?.('open')
    socket.onclose = () => onStatus?.('closed')
    socket.onerror = () => onStatus?.('error')
    socket.onmessage = (msg) => {
      if (closed) return
      try {
        const envelope = JSON.parse(msg.data)
        const intent = envelope?.intent || ''
        if (intent.startsWith('governance.incident.')) {
          onEvent(envelope)
        }
      } catch (err) {
        console.warn('[MON-GOV] incident event parse failed:', err?.message || err)
      }
    }
  } catch (err) {
    console.warn('[MON-GOV] incident subscription failed:', err?.message || err)
    onStatus?.('error')
  }

  return function dispose() {
    closed = true
    if (socket && socket.readyState === 1) {
      try { socket.close() } catch { /* ignore */ }
    }
  }
}
