/**
 * ApprovalsQ API client. Browser -> collector. Session cookie auth only
 * (credentials: 'include'), no bearer header. Server-side is the source of
 * truth: nothing is cached in the browser.
 */
const POLICY_URL = '/collector/api/v1/plugins/quox-voice/storage/approvalsq.policy'
const ESCALATIONS_URL = '/collector/api/v1/approvalsq/escalations'

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

export const DEFAULT_POLICY = {
  enabled: false,
  age_threshold_minutes: 15,
  quiet_hours: { start: '22:00', end: '08:00', timezone: 'Europe/London' },
  max_retries: 3,
  gap_minutes: 2,
  destination_number: null,
  min_tier: 'tier1',
  voicemail_policy: 'leave',
}

export const approvalsApi = {
  /** GET the stored policy blob (resp.value). 404 or empty means "use defaults". */
  async getPolicy() {
    try {
      const resp = await request(POLICY_URL)
      return resp?.value || null
    } catch (e) {
      if (e.status === 404) return null
      throw e
    }
  },
  /** PUT the policy blob as { value }. */
  putPolicy(policy) {
    return request(POLICY_URL, { method: 'PUT', body: { value: policy } })
  },
  /** GET recent escalations (resp.escalations). The route may not be deployed yet. */
  async listEscalations() {
    const resp = await request(ESCALATIONS_URL)
    return resp?.escalations || []
  },
}
