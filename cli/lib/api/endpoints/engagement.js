/**
 * 'engagement.*' endpoints — QUOX-SECURITY Phase 0 engagement/scope API.
 * Collector-native (services/collector/server.js:
 * app.post/get('/api/v1/security/engagements...', requireServiceOrUserAuth(), ...)),
 * not a proxy. org_id is derived server-side from the authenticated user,
 * same as the wazuh and quoxagent endpoint fragments, never sent by the CLI.
 *
 * NAMING NOTE: the REST path is /api/v1/security/engagements/* but the
 * endpoint-key prefix here is `engagement.*`, not `security.*` — that
 * prefix is already taken by services/auth/routes/orgSecurity.js's org
 * session-policy/ip-allowlist/MFA settings (cli/lib/api/endpoints/security.js),
 * a genuinely different product concern (org access-control settings, not a
 * security-testing engagement's scope/policy object). The fragment guard
 * (test/api/endpoints-fragments.test.js) requires key prefix === filename
 * minus '.js', so this needed its own file either way.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const engagement = {
  'engagement.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/security/engagements`,
    tags: ['live-write'],
  },
  'engagement.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/security/engagements`,
    tags: ['live-safe'],
  },
  'engagement.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/api/v1/security/engagements/${id}`,
    tags: ['live-safe'],
  },
  // Per-engagement gripe target: which repo a finding filed from this
  // engagement goes to, and which org's GitHub connector token files it.
  // lib/securityEngagement.js's setEngagementGripeTarget.
  'engagement.gripe_target.set': {
    method: 'PATCH',
    service: 'collector',
    path: ({ id }) => `/api/v1/security/engagements/${id}/gripe-target`,
    tags: ['live-write'],
  },
  'engagement.target.create': {
    method: 'POST',
    service: 'collector',
    path: ({ id }) => `/api/v1/security/engagements/${id}/targets`,
    tags: ['live-write'],
  },
  'engagement.target.verify': {
    method: 'POST',
    service: 'collector',
    path: ({ id, targetId }) => `/api/v1/security/engagements/${id}/verify-target/${targetId}`,
    tags: ['live-write'],
  },
  // Phase 1 parity fix: the policy gate and the 3 real capability tools
  // (lib/securityCapabilityTools.js) were agent-only until this route
  // existed. Still policy-gated first, still honest about no scan host
  // being configured, this is the same safety envelope as the agent path.
  'engagement.check_policy': {
    method: 'POST',
    service: 'collector',
    path: ({ id }) => `/api/v1/security/engagements/${id}/check-policy`,
    tags: ['live-safe'],
  },
  'engagement.capability': {
    method: 'POST',
    service: 'collector',
    path: ({ id, tool }) => `/api/v1/security/engagements/${id}/capability/${tool}`,
    tags: ['live-write'],
  },
  // COVERAGE Phase 2: httpx-based app-port discovery on a bare in-scope host,
  // finding the ports that actually serve HTTP(S) so a scan hits the real
  // surface, not only :80/:443. With { add:true } each discovered endpoint is
  // registered + verified as a url target. lib/securityAppPortDiscovery.js.
  'engagement.discover_app_ports': {
    method: 'POST',
    service: 'collector',
    path: ({ id }) => `/api/v1/security/engagements/${id}/discover-app-ports`,
    tags: ['live-write'],
  },
  // Quoxcli-parity fix: this catalog existed for the dashboard's Tools tab
  // but was never CLI-reachable. lib/securityCapabilityTools.js's
  // getCapabilityToolCatalog().
  'engagement.capability_tools': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/security/capability-tools`,
    tags: ['live-safe'],
  },
  // Async job model (found live 2026-08-10/11: a real sectest_vuln_scan/
  // nuclei run outruns the sync route's 30s budget). Same policy gate,
  // returns job_id immediately, poll engagement.job.get for the result.
  'engagement.capability.start': {
    method: 'POST',
    service: 'collector',
    path: ({ id, tool }) => `/api/v1/security/engagements/${id}/capability/${tool}/start`,
    tags: ['live-write'],
  },
  'engagement.job.get': {
    method: 'GET',
    service: 'collector',
    path: ({ jobId }) => `/api/v1/security/jobs/${jobId}`,
    tags: ['live-safe'],
  },
  'engagement.jobs.list': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/api/v1/security/engagements/${id}/jobs`,
    tags: ['live-safe'],
  },
  // Findings storage (Phase 1, continued): closes the "no findings storage"
  // gap. lib/securityFindings.js.
  'engagement.findings.report': {
    method: 'POST',
    service: 'collector',
    path: ({ id }) => `/api/v1/security/engagements/${id}/findings`,
    tags: ['live-write'],
  },
  'engagement.findings.list': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/api/v1/security/engagements/${id}/findings`,
    tags: ['live-safe'],
  },
  'engagement.findings.verify': {
    method: 'POST',
    service: 'collector',
    path: ({ findingId }) => `/api/v1/security/findings/${findingId}/verify`,
    tags: ['live-write'],
  },
  // Quoxcli-parity fix: marks a finding remediated ("resolved"), e.g. after
  // the GitHub issue it was filed as was closed. lib/securityFindings.js.
  'engagement.findings.resolve': {
    method: 'POST',
    service: 'collector',
    path: ({ findingId }) => `/api/v1/security/findings/${findingId}/resolve`,
    tags: ['live-write'],
  },
  // Re-grade a finding's severity after it was reported (quox#601). Governed +
  // witnessed; a reason is required. lib/securityFindings.js regradeFinding.
  'engagement.findings.regrade': {
    method: 'POST',
    service: 'collector',
    path: ({ findingId }) => `/api/v1/security/findings/${findingId}/regrade`,
    tags: ['live-write'],
  },
  // Finding -> next-steps pipeline: lib/securityReportActions.js. Raise as
  // Gripe (GitHub issue), Propose as QuoxPlan (a note on the QUOX-SECURITY
  // stream), Download PDF (whole engagement report). Email PDF is
  // explicitly out of scope (needs SMTP).
  'engagement.report.pdf': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/api/v1/security/engagements/${id}/report.pdf`,
    tags: ['live-safe'],
  },
  'engagement.findings.gripe': {
    method: 'POST',
    service: 'collector',
    path: ({ findingId }) => `/api/v1/security/findings/${findingId}/gripe`,
    tags: ['live-write'],
  },
  'engagement.findings.propose': {
    method: 'POST',
    service: 'collector',
    path: ({ findingId }) => `/api/v1/security/findings/${findingId}/quoxplan`,
    tags: ['live-write'],
  },
  // QUOX-SECURITY-SCHED Phase 4: recurring scan schedules, backed by
  // lib/securityEngagementSchedules.js (Phase 1 storage) and driven by the
  // server-side scheduler (lib/securityScanScheduler.js, Phase 2). Cadence is
  // interval (interval_seconds) or cron (schedule_kind:'cron' + cron_expression,
  // a 5-field UTC expression); the command builds the body, this fragment is a
  // pure route descriptor.
  'engagement.schedule.create': {
    method: 'POST',
    service: 'collector',
    path: ({ id }) => `/api/v1/security/engagements/${id}/schedules`,
    tags: ['live-write'],
  },
  'engagement.schedule.list': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/api/v1/security/engagements/${id}/schedules`,
    tags: ['live-safe'],
  },
  'engagement.schedule.get': {
    method: 'GET',
    service: 'collector',
    path: ({ scheduleId }) => `/api/v1/security/schedules/${scheduleId}`,
    tags: ['live-safe'],
  },
  'engagement.schedule.update': {
    method: 'PATCH',
    service: 'collector',
    path: ({ scheduleId }) => `/api/v1/security/schedules/${scheduleId}`,
    tags: ['live-write'],
  },
  'engagement.schedule.enable': {
    method: 'POST',
    service: 'collector',
    path: ({ scheduleId }) => `/api/v1/security/schedules/${scheduleId}/enable`,
    tags: ['live-write'],
  },
  'engagement.schedule.disable': {
    method: 'POST',
    service: 'collector',
    path: ({ scheduleId }) => `/api/v1/security/schedules/${scheduleId}/disable`,
    tags: ['live-write'],
  },
  'engagement.schedule.delete': {
    method: 'DELETE',
    service: 'collector',
    path: ({ scheduleId }) => `/api/v1/security/schedules/${scheduleId}`,
    tags: ['live-write'],
  },
  // Quoxcli-parity fix: best-effort sync of GitHub issue states onto this
  // engagement's filed findings (a closed issue auto-resolves its finding).
  // lib/securityReportActions.js's syncFindingIssueStates.
  'engagement.sync_issue_states': {
    method: 'POST',
    service: 'collector',
    path: ({ id }) => `/api/v1/security/engagements/${id}/sync-issue-states`,
    tags: ['live-write'],
  },
};
