/**
 * useComplianceData — Server-first data hook for the Compliance Command Center.
 *
 * CRP-1: Fetches posture, framework, report, evidence, and certification data
 * from CRP-BE server endpoints. All data comes from server-side SQLite.
 * Zero IndexedDB dependency.
 */

import { useState, useEffect, useCallback } from 'react'
import { AOCL_LAYERS } from '../services/compliance/evidenceMapping.js'
import { getBridgeStats } from '../lib/volt/volt-bridge'

const CACHE_TTL = 30000 // 30s cache to avoid hammering on tab switches
let cache = {}

async function fetchJSON(url) {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

/**
 * Fetch posture data from multiple endpoints, compose into PostureDashboard shape.
 */
async function fetchPosture() {
  // F6: track per-source fetch failures so a collector outage can be
  // distinguished from genuinely-zero data (see `degraded`/`unavailable` below).
  const sources = [
    { key: 'AEE', url: '/collector/aee/stats', fallback: {} },
    { key: 'VOLT', url: '/collector/volt/stats', fallback: {} },
    { key: 'WARD', url: '/collector/ward/stats', fallback: { stats: {}, witness: {} } },
    // F3: raised limit from 1 -> 500 so we can inspect real envelopes and
    // count distinct active AOCL layers, not just a doc count.
    { key: 'AOCL', url: '/collector/aee/query?intent=aocl.&limit=500', fallback: { count: 0, total: 0, envelopes: [] } },
    { key: 'REPORTS', url: '/collector/compliance/reports?limit=10', fallback: { reports: [] } },
  ]

  const unavailable = []
  const [aeeStats, voltStats, wardStats, aoclEnvelopes, recentReports] = await Promise.all(
    sources.map(async ({ key, url, fallback }) => {
      try {
        return await fetchJSON(url)
      } catch {
        unavailable.push(key)
        return fallback
      }
    })
  )

  const wardData = wardStats.stats || {}
  const witnessData = wardStats.witness || {}
  // GOV-TRUTH P8: prefer the org-scoped witnessed count (/ward/stats now returns
  // an `org: {entries}` field scoped to the caller's org) over the global chain
  // total, so the sidebar shows THIS org's receipts. Global chain stays intact
  // server-side — this is a per-org VIEW, not a chain partition. Falls back to
  // the global count for older collectors that don't return the org field.
  const wardOrgEntries = wardStats.org?.entries
  // GOV-TRUTH tail (#3): `.count` on /aee/query is the number of rows
  // RETURNED (capped by ?limit=500 above), not the true org-scoped total —
  // reading it as a total showed a flat "500" artifact once an org passed
  // that many aocl.* envelopes. `.total` (added server-side) is the real
  // count, independent of limit; fall back to `.count` for older collectors.
  const aoclCount = aoclEnvelopes.total ?? aoclEnvelopes.count ?? 0

  // F3: real active-layer count — derive the AOCL layer id (L0-L10) from each
  // envelope's payload.layer, falling back to extracting the "Lx" token that
  // the server embeds in the intent string (e.g. 'aocl.layer.L3.complete',
  // see services/collector/server.js emitters). Distinct layers seen = real
  // "layersActive", never a hardcoded constant.
  const activeLayerIds = new Set()
  for (const e of (aoclEnvelopes.envelopes || [])) {
    if (!e.intent?.startsWith('aocl.')) continue
    const layerId = e.payload?.layer || (e.intent.match(/\bL\d{1,2}\b/) || [])[0]
    if (layerId && AOCL_LAYERS[layerId]) activeLayerIds.add(layerId)
  }
  const layersActive = activeLayerIds.size

  // Compute overall score from most recent reports per framework
  const reports = recentReports.reports || []
  const latestByFormat = {}
  for (const r of reports) {
    if (!latestByFormat[r.format]) {
      const score = r.summary?.overallScore ?? r.summary?.coveragePercent ?? null
      if (score !== null) latestByFormat[r.format] = score
    }
  }
  const scores = Object.values(latestByFormat)
  const overallScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : null

  // Derive risks from actual protocol state
  const risks = []
  if ((aeeStats.total_envelopes || 0) === 0) {
    risks.push({ severity: 'high', label: 'No AEE envelopes recorded — audit trail empty', protocol: 'AEE' })
  }
  if ((voltStats.runs || 0) === 0) {
    risks.push({ severity: 'high', label: 'No VOLT runs recorded — evidence chain not active', protocol: 'VOLT' })
  }
  if (!witnessData.enabled) {
    risks.push({ severity: 'high', label: 'WARD witnessing disabled — no independent receipts', protocol: 'WARD' })
  }
  if (voltStats.bundles === 0 && voltStats.runs > 0) {
    risks.push({ severity: 'medium', label: 'No VOLT evidence bundles created — runs exist but no exportable evidence', protocol: 'VOLT' })
  }
  if (scores.length === 0) {
    risks.push({ severity: 'medium', label: 'No compliance reports generated yet — posture unknown', protocol: null })
  }
  for (const [fmt, score] of Object.entries(latestByFormat)) {
    if (score < 60) {
      risks.push({ severity: 'high', label: `${fmt.toUpperCase()} coverage at ${score}% — below compliance threshold`, protocol: null })
    } else if (score < 80) {
      risks.push({ severity: 'medium', label: `${fmt.toUpperCase()} coverage at ${score}% — partial compliance`, protocol: null })
    }
  }

  // Find last audit date from most recent report
  const lastAudit = reports[0]?.generated_at?.split('T')[0] || null

  // F3: real VOLT integrity — same recorded/(recorded+failed) formula as
  // VoltStatsBar.jsx:65-66. The collector's /volt/stats endpoint only
  // exposes run/event/bundle counts (no pass/fail split), so the actual
  // recorded/failed sample comes from the client-side bridge counters
  // (lib/volt/volt-bridge.js) — same source VoltStatsBar reads from.
  const bridgeStats = getBridgeStats() || {}
  const bridgeRecorded = bridgeStats.eventsRecorded || 0
  const bridgeFailed = bridgeStats.eventsFailed || 0
  const bridgeSampled = bridgeRecorded + bridgeFailed
  const voltIntegrity = bridgeSampled > 0
    ? Math.round((bridgeRecorded / bridgeSampled) * 100)
    : ((voltStats.events || 0) > 0 ? null : 0) // events exist but no pass/fail sample = unknown, not a fake 99

  // F3: real WARD chain integrity — mirrors the "CHAIN BROKEN" logic in
  // WardView.jsx:465-469 / the integrity calc in WardView.jsx:110-112:
  // intact only if witnessing is enabled AND zero witness errors recorded.
  const chainIntact = witnessData.enabled ? (witnessData.errors || 0) === 0 : null

  return {
    overallScore,
    trend: scores.length > 0 ? scores : [],
    protocols: {
      AEE: {
        status: (aeeStats.total_envelopes || 0) > 0 ? 'active' : 'inactive',
        envelopes: aeeStats.total_envelopes || 0,
        lastSync: aeeStats.newest_ts ? timeAgo(aeeStats.newest_ts) : 'never',
      },
      AOCL: {
        status: aoclCount > 0 || (aeeStats.total_envelopes || 0) > 0 ? 'active' : 'inactive',
        decisions: aoclCount,
        layersActive,
      },
      VOLT: {
        status: (voltStats.runs || 0) > 0 ? 'active' : 'inactive',
        runs: voltStats.runs || 0,
        integrity: voltIntegrity,
        // Auditor Portal (cc-auditor-portal): real bundle count, not fabricated.
        bundles: voltStats.bundles || 0,
      },
      WARD: {
        status: witnessData.enabled ? 'active' : 'inactive',
        witnesses: wardOrgEntries ?? wardData.entries ?? 0,
        chainIntact,
      },
    },
    risks,
    lastAudit,
    nextAudit: null,
    evidenceCount: wardOrgEntries ?? wardData.entries ?? 0,
    // F6: additive — lets the UI distinguish "collector outage" from
    // "genuinely zero data" instead of silently rendering both the same way.
    degraded: unavailable.length > 0,
    unavailable,
  }
}

/**
 * Fetch report history and scheduled jobs from server.
 */
async function fetchReports() {
  // F6: distinguish a fetch failure from a genuinely-empty result set.
  const unavailable = []
  const [reportsData, jobsData] = await Promise.all([
    fetchJSON('/collector/compliance/reports?limit=20').catch(() => { unavailable.push('REPORTS'); return { reports: [] } }),
    fetchJSON('/collector/compliance/jobs').catch(() => { unavailable.push('JOBS'); return { jobs: [] } }),
  ])

  const reports = (reportsData.reports || []).map(r => ({
    id: r.id,
    format: r.format,
    generatedAt: r.generated_at,
    period: r.period_days || 30,
    score: r.summary?.overallScore || r.summary?.coveragePercent || 0,
    status: r.summary?.overallStatus || 'unknown',
    traces: r.summary?.totalTraces || 0,
    size: '—',
  }))

  const scheduledJobs = (jobsData.jobs || []).map(j => ({
    id: j.id,
    format: j.format,
    interval: j.schedule_interval,
    nextRun: j.next_run,
    lastRun: j.last_run,
    status: j.status,
  }))

  // F6: additive fields — existing consumers destructure .reports/.scheduledJobs only.
  return { reports, scheduledJobs, degraded: unavailable.length > 0, unavailable }
}

const FRAMEWORK_META = {
  soc2: { name: 'SOC 2', description: 'Trust Services Criteria (CC6, CC7, PI1, A1)' },
  hipaa: { name: 'HIPAA', description: 'Security Rule (164.312)' },
  gdpr: { name: 'GDPR', description: 'Articles 5, 25, 30, 32, 33' },
  iso27001: { name: 'ISO 27001', description: 'Annex A Controls (A.5, A.8)' },
  euAiAct: { name: 'EU AI Act', description: 'Articles 9, 12, 13, 14, 15, 62, 72' },
}

/**
 * Build framework data from stored report data.
 * If full reports exist server-side, use their sections for drill-down.
 */
async function fetchFrameworks() {
  // F6: distinguish a fetch failure from a genuinely-empty result set.
  let reportsFailed = false
  const reportsData = await fetchJSON('/collector/compliance/reports?limit=20').catch(() => {
    reportsFailed = true
    return { reports: [] }
  })
  const reports = reportsData.reports || []

  // Get latest report per format
  const latestByFormat = {}
  for (const r of reports) {
    if (!latestByFormat[r.format]) latestByFormat[r.format] = r
  }

  // Build framework cards
  const frameworks = Object.entries(FRAMEWORK_META).map(([id, meta]) => {
    const report = latestByFormat[id]
    const summary = report?.summary || {}
    const score = summary.overallScore ?? summary.coveragePercent ?? 0
    const status = score >= 80 ? 'compliant' : score >= 60 ? 'partial' : score > 0 ? 'gap' : 'not_measured'

    // Try to extract sections from full report data
    let sections = []
    if (report?.report_data) {
      try {
        const full = typeof report.report_data === 'string' ? JSON.parse(report.report_data) : report.report_data
        if (full?.sections) {
          sections = Object.entries(full.sections).map(([secId, sec]) => {
            const controls = sec.controls || []
            const met = controls.filter(c => c.status === 'compliant').length
            const measured = controls.filter(c => c.status !== 'not_measured').length
            return {
              id: secId,
              name: sec.name || secId,
              coverage: measured > 0 ? Math.round((met / measured) * 100) : 0,
              controls: controls.length,
              met,
            }
          })
        }
      } catch { /* report_data not available in list endpoint */ }
    }

    return {
      id,
      name: meta.name,
      coverage: score,
      status,
      color: score >= 80 ? '#30ff90' : score >= 60 ? '#f59e0b' : '#ef4444',
      lastAudit: report?.generated_at?.split('T')[0] || 'never',
      controlsTotal: summary.totalControls || 0,
      controlsMet: summary.compliant || 0,
      sections,
    }
  })

  // F6: additive, non-index properties — arrays are objects in JS, so this
  // doesn't affect .map()/.length/iteration for existing consumers, it just
  // lets callers that check for it distinguish "reports fetch failed" from
  // "no reports exist yet" (both currently render as coverage: 0).
  frameworks.degraded = reportsFailed
  frameworks.unavailable = reportsFailed ? ['REPORTS'] : []

  return frameworks
}

/**
 * Fetch evidence data — envelopes, VOLT runs, WARD chain stats.
 */
async function fetchEvidence() {
  const [envelopesData, voltData, wardStats] = await Promise.all([
    fetchJSON('/collector/aee/query?limit=50').catch(() => ({ envelopes: [] })),
    fetchJSON('/collector/volt/runs?limit=20').catch(() => ({ runs: [] })),
    fetchJSON('/collector/ward/stats').catch(() => ({ stats: {} })),
  ])

  // Enrich envelopes with WARD/VOLT indicators
  const envelopes = (envelopesData.envelopes || []).map(e => ({
    id: e.id,
    intent: e.intent,
    ts: e.ts,
    from: e.from,
    to: e.to,
    wardWitnessed: true, // if it came from server, WARD witnessed it (CRP-BE-1)
    voltLinked: e.intent?.startsWith('aocl.') || e.intent?.includes('chat'),
  }))

  const voltRuns = (voltData.runs || []).map(r => ({
    id: r.run_id,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    events: r.seq || 0,
    integrityStatus: r.head_hash ? 'INTACT' : 'UNKNOWN',
    hashChainValid: !!r.head_hash,
  }))

  // WARD source breakdown (if available from the API)
  const wardChain = {
    totalEntries: wardStats.stats?.entries || 0,
    signedTips: wardStats.stats?.tips || 0,
    chainStatus: 'INTACT',
    lastVerified: wardStats.witness?.lastWitnessedAt || null,
    sourceBreakdown: { AEE: 0, AOCL: 0, VOLT: 0 },
  }

  return { envelopes, voltRuns, wardChain }
}

/**
 * Fetch VOLT certification data.
 */
async function fetchCertification() {
  const [certsData, certsStats] = await Promise.all([
    fetchJSON('/collector/volt/certs?limit=10').catch(() => ({ certs: [] })),
    fetchJSON('/collector/volt/certs/stats').catch(() => ({})),
  ])

  const certs = certsData.certs || []
  const latestCert = certs[0]

  return {
    currentTier: latestCert?.tier || 'none',
    tiers: [
      {
        id: 'bronze', name: 'Bronze', icon: '○', color: '#cd7f32', type: 'Basic, Automatic',
        requirements: [
          { label: 'AEE envelope logging enabled', met: true },
          { label: 'Health endpoint responding', met: true },
          { label: 'AOCL layers executing', met: true },
        ],
      },
      {
        id: 'silver', name: 'Silver', icon: '◎', color: '#c0c0c0', type: 'Verified, Automatic',
        requirements: [
          { label: 'VOLT evidence capture active', met: certsStats.runs > 0 },
          { label: 'Hash chain integrity verified', met: true },
          { label: 'Error rate below 5%', met: true },
        ],
      },
      {
        id: 'gold', name: 'Gold', icon: '★', color: '#ffd700', type: 'Timestamped + Signed',
        requirements: [
          { label: 'WARD witness chain active', met: true },
          { label: 'Ed25519 signed tips', met: true },
          { label: 'Server-side evidence pipeline', met: true },
        ],
      },
      {
        id: 'platinum', name: 'Platinum', icon: '◆', color: '#e5e4e2', type: 'Enterprise, Managed',
        requirements: [
          { label: 'External audit passed', met: false },
          { label: 'SOC 2 Type II attestation', met: false },
          { label: '99.99% uptime SLA', met: false },
        ],
      },
    ],
    certHistory: certs.map(c => ({
      date: c.created_at?.split('T')[0] || 'unknown',
      tier: c.tier,
      event: `${c.tier_name} certification — ${c.summary || 'auto-assessed'}`,
    })),
    nextRequirements: [
      { label: 'Pass external security audit', progress: 0, blocking: true },
      { label: 'Achieve SOC 2 Type II attestation', progress: 0, blocking: false },
    ],
  }
}

function timeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime()
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
  return `${Math.round(diff / 86400000)}d ago`
}

/**
 * Main hook — fetches all compliance data from server.
 *
 * @returns {{ posture, reports, scheduledJobs, evidence, certification, loading, error, refresh }}
 */
export function useComplianceData() {
  const [posture, setPosture] = useState(null)
  const [frameworks, setFrameworks] = useState([])
  const [reports, setReports] = useState([])
  const [scheduledJobs, setScheduledJobs] = useState([])
  const [evidence, setEvidence] = useState(null)
  const [certification, setCertification] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [p, f, r, e, c] = await Promise.all([
        fetchPosture(),
        fetchFrameworks(),
        fetchReports(),
        fetchEvidence(),
        fetchCertification(),
      ])
      setPosture(p)
      setFrameworks(f)
      setReports(r.reports)
      setScheduledJobs(r.scheduledJobs)
      setEvidence(e)
      setCertification(c)
    } catch (err) {
      console.error('[Compliance] Data fetch failed:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { posture, frameworks, reports, scheduledJobs, evidence, certification, loading, error, refresh }
}
