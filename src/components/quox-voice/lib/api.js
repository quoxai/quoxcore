/**
 * Quox Voice schedules API client. Browser -> collector proxy -> voice bridge
 * (OutboundQ scheduled calls). Server-side is the source of truth: no
 * localStorage, no read cache, every list call goes to the server.
 */
const API = '/collector/api/v1/telephony-schedules'

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `API error ${status}`)
    this.status = status
    this.body = body
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let payload = null
  try {
    payload = await res.json()
  } catch {
    payload = null
  }
  if (!res.ok) throw new ApiError(res.status, payload)
  return payload
}

export const api = {
  /** GET /api/v1/telephony-schedules -> { schedules: [...] }, returns the array. */
  async listSchedules() {
    const resp = await request(API)
    return resp?.schedules || []
  },
  /** POST /api/v1/telephony-schedules */
  createSchedule(body) {
    return request(API, { method: 'POST', body })
  },
  /** PATCH /api/v1/telephony-schedules/:id */
  updateSchedule(id, body) {
    return request(`${API}/${encodeURIComponent(id)}`, { method: 'PATCH', body })
  },
  /** DELETE /api/v1/telephony-schedules/:id */
  deleteSchedule(id) {
    return request(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  /** PATCH /api/v1/telephony-schedules/:id with { enabled } */
  setEnabled(id, enabled) {
    return request(`${API}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { enabled } })
  },
}
