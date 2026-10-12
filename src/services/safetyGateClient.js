/**
 * quox#503 — Kill Switch / DEFCON API Client
 *
 * Thin wrapper over the collector's /api/v1/safety REST endpoints
 * (services/collector/routes/safetyGate.js). This is the ONLY source of
 * truth SafetyContext.jsx reads/writes for killSwitchActive/currentDefcon —
 * localStorage is a cache, not the source (ZERO TOLERANCE, repo CLAUDE.md):
 * a fresh browser must see the same halt state as the one that pressed
 * E-STOP.
 *
 * Mirrors governanceIncidentsClient.js: `credentials: 'include'` so the
 * auth-service JWT cookie rides along, responses unwrapped from their
 * envelope.
 */

const BASE = '/collector/api/v1/safety'

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

/** GET /status — { org_id, defcon, killSwitches: [{agent_id, reason, activated_by, activated_at}] } */
export async function getSafetyStatus() {
  return request(`${BASE}/status`)
}

/** POST /kill-switch/:agentId — human-admin only. Returns { ok, org_id, agent_id, active, was_active }. */
export async function activateKillSwitch(agentId, reason) {
  return request(`${BASE}/kill-switch/${encodeURIComponent(agentId)}`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason || null }),
  })
}

/** DELETE /kill-switch/:agentId — human-admin only. Returns { ok, org_id, agent_id, active: false }. */
export async function deactivateKillSwitch(agentId) {
  return request(`${BASE}/kill-switch/${encodeURIComponent(agentId)}`, { method: 'DELETE' })
}

/** POST /defcon — human-admin only. Returns { ok, org_id, old_level, new_level }. */
export async function setDefconLevel(level, reason) {
  return request(`${BASE}/defcon`, {
    method: 'POST',
    body: JSON.stringify({ level, reason: reason || null }),
  })
}

/** GET /history?agent_id=&limit= — admin-role only. Returns { history: [...] }. */
export async function getSafetyHistory(params = {}) {
  const qs = new URLSearchParams()
  if (params.agentId) qs.set('agent_id', params.agentId)
  if (params.limit) qs.set('limit', String(params.limit))
  const str = qs.toString()
  return request(`${BASE}/history${str ? `?${str}` : ''}`)
}
