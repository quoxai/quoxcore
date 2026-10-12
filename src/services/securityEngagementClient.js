/**
 * Security Engagement Client (QUOX-SECURITY Phase 1)
 *
 * Wraps the real REST API at /api/v1/security/engagements/* via the
 * collector proxy, same shape as triggersClient.js: authFetch from
 * useAuth(), credentials: 'include', throw a readable Error on !res.ok.
 *
 * Proxy base: /collector/api/v1/security
 */

const PROXY_BASE = '/collector/api/v1/security'

async function request(fetcher, path, options = {}) {
  const res = await fetcher(`${PROXY_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body?.success === false) {
    throw new Error(body?.error || `Request failed: HTTP ${res.status}`)
  }
  return body
}

export async function listEngagements({ authFetch } = {}) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, '/engagements')
  return body.engagements || []
}

export async function createEngagement({ authFetch, name, environmentTier, riskCeiling, responsibleProject }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, '/engagements', {
    method: 'POST',
    body: JSON.stringify({
      name,
      environment_tier: environmentTier,
      ...(riskCeiling ? { risk_ceiling: riskCeiling } : {}),
      ...(responsibleProject ? { responsible_project: responsibleProject } : {}),
    }),
  })
  return body.engagement
}

export async function getEngagement({ authFetch, id }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/engagements/${encodeURIComponent(id)}`)
  return { engagement: body.engagement, targets: body.targets || [] }
}

// Per-engagement gripe target: which repo a finding filed from this
// engagement goes to (gripe_repo, null = platform default quoxai/quox) and
// which org GitHub connector token files it (gripe_connector_org_id, null =
// the engagement own org). Full set: both fields are replaced. Returns the
// updated engagement.
export async function setGripeTarget({ authFetch, engagementId, gripe_repo, gripe_connector_org_id }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/engagements/${encodeURIComponent(engagementId)}/gripe-target`, {
    method: 'PATCH',
    body: JSON.stringify({
      gripe_repo: gripe_repo || null,
      gripe_connector_org_id: gripe_connector_org_id || null,
    }),
  })
  return body.engagement
}

export async function addTarget({ authFetch, engagementId, type, value, verificationMethod }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/engagements/${encodeURIComponent(engagementId)}/targets`, {
    method: 'POST',
    body: JSON.stringify({ type, value, ...(verificationMethod ? { verification_method: verificationMethod } : {}) }),
  })
  return body.target
}

export async function verifyTarget({ authFetch, engagementId, targetId }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/engagements/${encodeURIComponent(engagementId)}/verify-target/${encodeURIComponent(targetId)}`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return body.target
}

export async function checkPolicy({ authFetch, engagementId, targetValue, capabilityRisk }) {
  const fetcher = authFetch || fetch
  return request(fetcher, `/engagements/${encodeURIComponent(engagementId)}/check-policy`, {
    method: 'POST',
    body: JSON.stringify({ target_value: targetValue, capability_risk: capabilityRisk }),
  })
}

export async function listCapabilityTools({ authFetch } = {}) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, '/capability-tools')
  return body.tools || []
}

// Not routed through request(): a capability run legitimately returns
// success:false for an honest, structured, non-exceptional outcome (policy
// denial, "command not found", a real "Connection refused"), the caller
// needs that full body to render it, not a thrown Error that only carries
// a message string. Only a genuine HTTP-level failure throws here.
export async function runCapabilityTool({ authFetch, engagementId, tool, target }) {
  const fetcher = authFetch || fetch
  const res = await fetcher(
    `${PROXY_BASE}/engagements/${encodeURIComponent(engagementId)}/capability/${encodeURIComponent(tool)}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    }
  )
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body?.error || `Request failed: HTTP ${res.status}`)
  }
  return body
}

// Async job model: for tools that can outrun a single request (e.g.
// vuln_scan/nuclei, found live 2026-08-10/11 to exceed the sync path's 30s
// budget). Not routed through request() for the same reason as
// runCapabilityTool: a policy denial is a legitimate structured response,
// not a thrown Error.
export async function startCapabilityToolJob({ authFetch, engagementId, tool, target }) {
  const fetcher = authFetch || fetch
  const res = await fetcher(
    `${PROXY_BASE}/engagements/${encodeURIComponent(engagementId)}/capability/${encodeURIComponent(tool)}/start`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    }
  )
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body?.error || `Request failed: HTTP ${res.status}`)
  }
  return body
}

export async function getScanJob({ authFetch, jobId }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/jobs/${encodeURIComponent(jobId)}`)
  return body.job
}

export async function listScanJobs({ authFetch, engagementId }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/engagements/${encodeURIComponent(engagementId)}/jobs`)
  return body.jobs || []
}

// ── Recurring scan schedules (QUOX-SECURITY-SCHED) ──────────────────────
// Durable, server-side scheduled scans. The dashboard reads their state
// (next_run_at, last_status, last_diff_json) and can enable/disable them;
// the scheduler that actually fires them lives in the collector.

export async function listSchedules({ authFetch, engagementId }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/engagements/${encodeURIComponent(engagementId)}/schedules`)
  return body.schedules || []
}

export async function getSchedule({ authFetch, scheduleId }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/schedules/${encodeURIComponent(scheduleId)}`)
  return body.schedule
}

export async function createSchedule({ authFetch, engagementId, tool, target_value, interval_seconds, schedule_kind, cron_expression, timezone }) {
  const fetcher = authFetch || fetch
  const payload = { tool, target_value }
  if (schedule_kind) payload.schedule_kind = schedule_kind
  if (cron_expression) payload.cron_expression = cron_expression
  if (timezone) payload.timezone = timezone
  if (interval_seconds !== undefined && interval_seconds !== null) payload.interval_seconds = interval_seconds
  const body = await request(fetcher, `/engagements/${encodeURIComponent(engagementId)}/schedules`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return body.schedule
}

// Partial edit of a schedule (target, tool, cadence, or enabled state). Only
// the provided fields are sent; the backend carries the rest over and
// re-validates. Returns the updated schedule.
export async function updateSchedule({ authFetch, scheduleId, ...patch }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return body.schedule
}

export async function enableSchedule({ authFetch, scheduleId }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/schedules/${encodeURIComponent(scheduleId)}/enable`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return body.schedule
}

export async function disableSchedule({ authFetch, scheduleId }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/schedules/${encodeURIComponent(scheduleId)}/disable`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return body.schedule
}

export async function deleteSchedule({ authFetch, scheduleId }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'DELETE',
  })
  return body.deleted === true
}

export async function listFindings({ authFetch, engagementId }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/engagements/${encodeURIComponent(engagementId)}/findings`)
  return body.findings || []
}

export async function reportFinding({ authFetch, engagementId, targetValue, title, description, severity }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/engagements/${encodeURIComponent(engagementId)}/findings`, {
    method: 'POST',
    body: JSON.stringify({ target_value: targetValue, title, description, severity }),
  })
  return body.finding
}

export async function verifyFinding({ authFetch, findingId, verdict, reason }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/findings/${encodeURIComponent(findingId)}/verify`, {
    method: 'POST',
    body: JSON.stringify({ verdict, reason }),
  })
  return body.finding
}

// ── Issue-state tracking (issues raised AND fixed) ──────────────────────
// resolveFinding marks a single finding fixed; syncIssueStates reconciles
// every gripe-linked finding against its upstream issue state (e.g. a closed
// GitHub issue flips its finding to resolved). Returns { configured, checked,
// resolved:[ids], errors:[...] } so the caller can surface the roll-up.

export async function resolveFinding({ authFetch, findingId }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/findings/${encodeURIComponent(findingId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return body.finding
}

export async function syncIssueStates({ authFetch, engagementId }) {
  const fetcher = authFetch || fetch
  return request(fetcher, `/engagements/${encodeURIComponent(engagementId)}/sync-issue-states`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

// ── Finding -> next-steps pipeline ──────────────────────────────────────
// Raise as Gripe / Propose as QuoxPlan / Download PDF. Not routed through
// request() for the gripe call: { configured: false } is an honest,
// non-exceptional outcome (GitHub not configured) the caller needs to
// render inline, not a thrown Error.

export async function fileFindingGripe({ authFetch, findingId }) {
  const fetcher = authFetch || fetch
  const res = await fetcher(`${PROXY_BASE}/findings/${encodeURIComponent(findingId)}/gripe`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body?.error || `Request failed: HTTP ${res.status}`)
  }
  return body
}

export async function proposeFindingQuoxplan({ authFetch, findingId, streamId }) {
  const fetcher = authFetch || fetch
  const body = await request(fetcher, `/findings/${encodeURIComponent(findingId)}/quoxplan`, {
    method: 'POST',
    body: JSON.stringify(streamId ? { stream_id: streamId } : {}),
  })
  return body
}

// Downloads the engagement report PDF as a Blob. Caller triggers a
// browser download (createObjectURL + <a download>) — this client only
// fetches the bytes, same separation as every other client in this file.
export async function downloadEngagementReportPdf({ authFetch, engagementId }) {
  const fetcher = authFetch || fetch
  const res = await fetcher(`${PROXY_BASE}/engagements/${encodeURIComponent(engagementId)}/report.pdf`, {
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.error || `Request failed: HTTP ${res.status}`)
  }
  return res.blob()
}

export const RISK_TIERS = ['passive', 'discovery', 'safe_active', 'intrusive', 'credential_sensitive', 'exploit_emulation']
export const ENVIRONMENT_TIERS = ['dev', 'staging', 'production']
export const TARGET_TYPES = ['domain', 'cidr', 'repo', 'cloud_account', 'url']
export const VERIFICATION_METHODS = ['dns_txt', 'well_known_file', 'quoxagent_install']
