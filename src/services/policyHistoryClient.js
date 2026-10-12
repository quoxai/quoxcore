/**
 * POL-HIST: Policy history REST client.
 *
 * Wraps /api/v1/policies/{:id/history, /history, /approvals/pending,
 * /approvals/:entryId/resolve}. Every request carries credentials so
 * the server can scope by req.user.org_id (once auth middleware lands
 * on the policy endpoints; until then org_id is passed as a query).
 */

const BASE = '/collector/api/v1/policies'

async function request(path, opts = {}) {
  const resp = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  })
  const body = await resp.json().catch(() => null)
  if (!resp.ok) {
    const err = new Error(body?.error || `${resp.status} ${resp.statusText}`)
    err.status = resp.status
    err.body = body
    throw err
  }
  return body
}

export async function listHistoryForPolicy(policyId, { limit = 50, offset = 0 } = {}) {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  return request(`${BASE}/${encodeURIComponent(policyId)}/history?${qs}`)
}

export async function listHistoryForOrg({ org_id, operation, actor_id, since, until, limit = 100, offset = 0 } = {}) {
  const qs = new URLSearchParams()
  if (org_id) qs.set('org_id', org_id)
  if (operation) qs.set('operation', operation)
  if (actor_id) qs.set('actor_id', actor_id)
  if (since) qs.set('since', since)
  if (until) qs.set('until', until)
  qs.set('limit', String(limit))
  qs.set('offset', String(offset))
  return request(`${BASE}/history?${qs}`)
}

export async function listPendingApprovals({ org_id } = {}) {
  const qs = new URLSearchParams()
  if (org_id) qs.set('org_id', org_id)
  return request(`${BASE}/approvals/pending?${qs}`)
}

export async function resolveApproval(entryId, { outcome, reason, approved_by } = {}) {
  return request(`${BASE}/approvals/${encodeURIComponent(entryId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ outcome, reason, approved_by }),
  })
}
