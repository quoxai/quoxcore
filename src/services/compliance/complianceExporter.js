/**
 * Compliance Exporter Service
 *
 * Generates compliance reports in various formats (SOC2, HIPAA, GDPR, ISO 27001).
 * Part of the AOCL Compliance Suite premium plugin.
 */

import { queryEnvelopesServer, getConversationsServer, getStatsServer, gatherVoltEvidenceServer } from './complianceDataService'
import { isComplianceSuiteEnabled, getAvailableExportFormats } from '../aoclPluginService'
// CRP-BE-5: orgGet/orgSet removed — jobs and reports now stored server-side
import { formatSOC2Report } from './formatters/soc2Formatter'
import { formatHIPAAReport } from './formatters/hipaaFormatter'
import { formatGDPRReport } from './formatters/gdprFormatter'
import { formatISO27001Report } from './formatters/iso27001Formatter'
import { formatEUAIActReport } from './formatters/euAiActFormatter'
import { formatISO42001Report } from './formatters/iso42001Formatter'
import { formatNISTAIRMFReport } from './formatters/nistAiRmfFormatter'

// VOLT imports — lazy-loaded to avoid circular deps and IndexedDB init at import time
let voltModulesLoaded = false
let voltModules = null

async function getVoltModules() {
  if (voltModulesLoaded) return voltModules
  voltModulesLoaded = true
  try {
    const [voltStore, voltBundler, voltVerify] = await Promise.all([
      import('../../lib/volt/volt-store.js'),
      import('../../lib/volt/volt-bundler.js'),
      import('../../lib/volt/volt-verify.js')
    ])
    voltModules = {
      queryRuns: voltStore.queryRuns,
      loadRunEvents: voltStore.loadRunEvents,
      createBundle: voltBundler.createBundle,
      serializeBundle: voltBundler.serializeBundle,
      verifyEvidenceBundle: voltVerify.verifyEvidenceBundle
    }
  } catch (_) {
    voltModules = null
  }
  return voltModules
}

// CRP-BE-5: Storage keys removed — jobs and reports now in server-side SQLite

/**
 * Available compliance formats
 */
export const COMPLIANCE_FORMATS = {
  json: {
    id: 'json',
    name: 'JSON',
    description: 'Raw JSON export of all trace data',
    free: true
  },
  soc2: {
    id: 'soc2',
    name: 'SOC 2',
    description: 'Trust Services Criteria (CC6, CC7, PI1)',
    free: false
  },
  hipaa: {
    id: 'hipaa',
    name: 'HIPAA',
    description: 'Security Rule (164.312)',
    free: false
  },
  gdpr: {
    id: 'gdpr',
    name: 'GDPR',
    description: 'Article 30 Records of Processing',
    free: false
  },
  iso27001: {
    id: 'iso27001',
    name: 'ISO 27001',
    description: 'Annex A Controls',
    free: false
  },
  euAiAct: {
    id: 'euAiAct',
    name: 'EU AI Act',
    description: 'High-risk AI system requirements (Art. 9-72)',
    free: false
  },
  iso42001: {
    id: 'iso42001',
    name: 'ISO/IEC 42001:2023',
    description: 'AI Management System — Clauses 4-10',
    free: false
  },
  nistAiRmf: {
    id: 'nistAiRmf',
    name: 'NIST AI RMF 1.0',
    description: 'AI Risk Management Framework — Govern/Map/Measure/Manage',
    free: false
  }
}

/**
 * Generate a compliance report
 * @param {string} format - 'json' | 'soc2' | 'hipaa' | 'gdpr' | 'iso27001'
 * @param {Object} options
 * @param {Object} options.period - { start: ISO string, end: ISO string }
 * @param {boolean} options.includeEvidence - Include raw trace evidence
 * @param {number} options.sampleSize - Number of sample traces to include
 * @returns {Promise<Object>} The compliance report
 */
export async function generateComplianceReport(format, options = {}) {
  const {
    period = getDefaultPeriod(),
    includeEvidence = true,
    sampleSize = 50
  } = options

  // Check license for premium formats
  if (format !== 'json') {
    const enabled = await isComplianceSuiteEnabled()
    if (!enabled) {
      throw new Error(`Format "${format}" requires AOCL Compliance Suite license`)
    }
  }

  // Gather trace data
  const traceData = await gatherTraceData(period, sampleSize)

  // Generate base report metadata
  const baseReport = {
    format,
    version: '2025.1',
    generatedAt: new Date().toISOString(),
    generatedBy: 'AOCL Compliance Suite',
    period: {
      start: period.start,
      end: period.end,
      days: Math.ceil((new Date(period.end) - new Date(period.start)) / (1000 * 60 * 60 * 24))
    },
    summary: {
      totalTraces: traceData.stats.totalEnvelopes,
      totalConversations: traceData.stats.totalConversations,
      totalLayerEvents: traceData.layerEvents.length,
      uniqueAgents: [...new Set(traceData.envelopes.map(e => e.to).filter(Boolean))].length
    }
  }

  // Format-specific report generation
  let report
  switch (format) {
    case 'soc2':
      report = formatSOC2Report(traceData, period, baseReport)
      break
    case 'hipaa':
      report = formatHIPAAReport(traceData, period, baseReport)
      break
    case 'gdpr':
      report = formatGDPRReport(traceData, period, baseReport)
      break
    case 'iso27001':
      report = formatISO27001Report(traceData, period, baseReport)
      break
    case 'euAiAct':
    case 'eu-ai-act':
      report = formatEUAIActReport(traceData, period, baseReport)
      break
    case 'iso42001':
      report = formatISO42001Report(traceData, period, baseReport)
      break
    case 'nistAiRmf':
    case 'nist-ai-rmf':
      report = formatNISTAIRMFReport(traceData, period, baseReport)
      break
    case 'json':
    default:
      report = {
        ...baseReport,
        data: {
          envelopes: traceData.envelopes,
          layerEvents: traceData.layerEvents,
          conversations: traceData.conversations
        }
      }
  }

  // Add evidence section if requested
  if (includeEvidence && format !== 'json') {
    report.evidence = {
      sampleTraces: traceData.sampleTraces,
      layerSamples: traceData.layerSamples,
      policyDecisions: traceData.policyDecisions
    }
  }

  // Add VOLT evidence when available
  if (traceData.voltEvidence) {
    report.voltEvidence = traceData.voltEvidence
  }

  // Save report to history
  await saveReportToHistory(report)

  return report
}

/**
 * Gather trace data for the specified period
 */
// CRP-AU-3: Compliance-relevant intent prefixes (exclude fleet ops noise)
const COMPLIANCE_INTENT_PREFIXES = [
  'quox.chat.',        // User-AI interactions — the core decision trail
  'quox.flow.',        // Workflow execution decisions
  'quox.agent.message', // Agent delegation/responses
  'aocl.',             // AOCL layer processing evidence
]

function isComplianceRelevant(envelope) {
  const intent = envelope.intent || ''
  if (COMPLIANCE_INTENT_PREFIXES.some(p => intent.startsWith(p))) return true
  if (envelope.type === 'error') return true  // Keep errors for incident detection
  return false
}

// IP pattern for redaction
const IP_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?::\d+)?\b/g

/**
 * Redact sensitive content from envelope before including in compliance reports.
 * Strips: internal metadata (_synced, _synced_at, _synced_status), internal IPs,
 * raw user prompts (truncated), API keys, hostnames.
 */
function redactEnvelope(envelope) {
  const clean = { ...envelope }

  // Strip internal sync metadata
  delete clean._synced
  delete clean._synced_at
  delete clean._synced_status
  delete clean._id

  // Redact payload content
  if (clean.payload && typeof clean.payload === 'object') {
    const p = { ...clean.payload }

    // Strip raw prompts and responses (keep only length)
    if (typeof p.text === 'string' && p.text.length > 100) {
      p.text = `[${p.text.length} chars redacted]`
    }
    if (typeof p.prompt === 'string' && p.prompt.length > 100) {
      p.prompt = `[${p.prompt.length} chars redacted]`
    }
    if (typeof p.response === 'string' && p.response.length > 100) {
      p.response = `[${p.response.length} chars redacted]`
    }
    if (typeof p.message === 'string' && p.message.length > 200) {
      p.message = p.message.substring(0, 100) + `... [${p.message.length} chars, truncated]`
    }

    // Strip secrets
    delete p.api_key
    delete p.token
    delete p.password
    delete p.authorization

    // Redact internal IPs from string fields
    for (const key of Object.keys(p)) {
      if (typeof p[key] === 'string') {
        p[key] = p[key].replace(IP_PATTERN, '[INTERNAL_IP]')
      }
    }

    clean.payload = p
  }

  // Redact IPs from top-level string fields
  if (typeof clean.from === 'string') clean.from = clean.from.replace(IP_PATTERN, '[INTERNAL_IP]')
  if (typeof clean.to === 'string') clean.to = clean.to.replace(IP_PATTERN, '[INTERNAL_IP]')

  return clean
}

async function gatherTraceData(period, sampleSize) {
  // CRP-BE-2: Query server-side SQLite first, IndexedDB fallback
  const rawEnvelopes = await queryEnvelopesServer({
    after: period.start,
    before: period.end,
    limit: 10000
  })

  // CRP-AU-3: Filter to compliance-relevant envelopes only
  const envelopes = rawEnvelopes.filter(isComplianceRelevant).map(redactEnvelope)

  // Get layer events specifically
  const layerEvents = envelopes.filter(e =>
    e.intent?.startsWith('aocl.layer.') || e.intent?.startsWith('aocl.run.')
  )

  // Get conversations
  const conversations = await getConversationsServer({
    after: period.start,
    limit: 1000
  })

  // Get overall stats
  const stats = await getStatsServer()

  // Get sample traces (random selection)
  const sampleTraces = selectRandomSample(
    envelopes.filter(e => e.type === 'task' || e.type === 'result'),
    sampleSize
  )

  // Get layer samples
  const layerSamples = {}
  const layerTypes = ['L0', 'L2', 'L3', 'L5', 'L7', 'L8', 'L9', 'L10']
  for (const layer of layerTypes) {
    const layerEvts = layerEvents.filter(e =>
      e.payload?.layer === layer || e.intent?.includes(layer.toLowerCase())
    )
    layerSamples[layer] = selectRandomSample(layerEvts, 5)
  }

  // Get policy decisions (L3 events)
  const policyDecisions = layerEvents.filter(e =>
    e.payload?.layer === 'L3' || e.intent?.includes('policy')
  )

  // CRP-BE-2: Gather VOLT evidence from server-side SQLite first
  const voltEvidence = await gatherVoltEvidenceServer(period)

  return {
    envelopes,
    layerEvents,
    conversations,
    stats,
    sampleTraces,
    layerSamples,
    policyDecisions,
    voltEvidence
  }
}

/**
 * Gather VOLT cryptographic evidence for the reporting period.
 * Returns null if VOLT store is not initialized.
 *
 * @param {Object} period - { start, end }
 * @returns {Promise<Object|null>}
 */
export async function gatherVoltEvidence(period) {
  const volt = await getVoltModules()
  if (!volt) return null

  try {
    // Find completed runs in the period
    const runs = await volt.queryRuns({
      status: 'completed',
      after: period.start,
      before: period.end
    })

    if (runs.length === 0) return null

    // Verify a sample of runs (up to 10)
    const sample = runs.slice(0, 10)
    const verifications = []

    for (const run of sample) {
      try {
        const events = await volt.loadRunEvents(run.run_id)
        if (events.length === 0) continue

        const bundle = await volt.createBundle({
          run: { ...run, events }
        })
        const serialized = volt.serializeBundle(bundle)
        const jsonStr = JSON.stringify(serialized)
        const result = await volt.verifyEvidenceBundle(jsonStr)

        verifications.push({
          run_id: run.run_id,
          valid: result.valid,
          event_count: result.summary.event_count,
          chain_valid: result.summary.chain_valid
        })
      } catch (err) {
        verifications.push({
          run_id: run.run_id,
          valid: false,
          error: err.message
        })
      }
    }

    const validCount = verifications.filter(v => v.valid).length

    return {
      total_runs: runs.length,
      verified_sample: verifications.length,
      valid_count: validCount,
      integrity_rate: verifications.length > 0
        ? Math.round((validCount / verifications.length) * 100)
        : 0,
      verifications
    }
  } catch (err) {
    console.warn('[Compliance] VOLT evidence gathering failed:', err.message)
    return null
  }
}

/**
 * Select random sample from array
 */
function selectRandomSample(arr, size) {
  if (arr.length <= size) return arr
  const shuffled = [...arr].sort(() => 0.5 - Math.random())
  return shuffled.slice(0, size)
}

/**
 * Get default period (last 30 days)
 */
function getDefaultPeriod() {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 30)
  return {
    start: start.toISOString(),
    end: end.toISOString()
  }
}

/**
 * Save report to server-side storage (CRP-BE-5)
 */
async function saveReportToHistory(report) {
  try {
    await fetch('/collector/compliance/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        format: report.format,
        period: report.period,
        summary: report.summary,
        report_data: report
      })
    })
  } catch (err) {
    console.warn('[Compliance] Failed to save report to server:', err)
  }
}

/**
 * Get report history from server (CRP-BE-5)
 * @returns {Promise<Array>} Report history
 */
export async function getReportHistory() {
  try {
    const res = await fetch('/collector/compliance/reports?limit=50', { credentials: 'include' })
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    const data = await res.json()
    return (data.reports || []).map(r => ({
      id: r.id,
      format: r.format,
      generatedAt: r.generated_at,
      period: { start: r.period_start, end: r.period_end, days: r.period_days },
      summary: r.summary
    }))
  } catch (err) {
    console.warn('[Compliance] Failed to get report history from server:', err)
    return []
  }
}

/**
 * Schedule a compliance job (CRP-BE-5: server-side)
 * @param {Object} schedule - { interval: 'daily' | 'weekly' | 'monthly', dayOfWeek?: number, dayOfMonth?: number }
 * @param {string} format - Compliance format
 * @param {Object} options - Report options
 * @returns {Promise<Object>} Created job
 */
export async function scheduleComplianceJob(schedule, format, options = {}) {
  const enabled = await isComplianceSuiteEnabled()
  if (!enabled) {
    throw new Error('Scheduled jobs require AOCL Compliance Suite license')
  }

  const res = await fetch('/collector/compliance/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ format, schedule, options })
  })
  if (!res.ok) throw new Error(`Failed to create job: ${res.status}`)
  const data = await res.json()
  return data.job
}

/**
 * Get all scheduled jobs (CRP-BE-5: server-side)
 * @returns {Promise<Array>} Scheduled jobs
 */
export async function getScheduledJobs() {
  try {
    const res = await fetch('/collector/compliance/jobs', { credentials: 'include' })
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    const data = await res.json()
    return (data.jobs || []).map(j => ({
      id: j.id,
      format: j.format,
      schedule: { interval: j.schedule_interval, dayOfWeek: j.schedule_day_of_week, dayOfMonth: j.schedule_day_of_month },
      options: typeof j.options === 'string' ? JSON.parse(j.options) : (j.options || {}),
      createdAt: j.created_at,
      lastRun: j.last_run,
      nextRun: j.next_run,
      lastError: j.last_error,
      status: j.status
    }))
  } catch (err) {
    console.warn('[Compliance] Failed to get jobs from server:', err)
    return []
  }
}

/**
 * Cancel a scheduled job (CRP-BE-5: server-side)
 * @param {string} jobId - Job ID to cancel
 */
export async function cancelScheduledJob(jobId) {
  try {
    await fetch(`/collector/compliance/jobs/${jobId}`, { method: 'DELETE', credentials: 'include' })
  } catch (err) {
    console.warn('[Compliance] Failed to cancel job:', err)
  }
}

/**
 * Update a scheduled job (CRP-BE-5: server-side)
 * @param {string} jobId - Job ID
 * @param {Object} updates - Updates to apply
 */
export async function updateScheduledJob(jobId, updates) {
  try {
    await fetch(`/collector/compliance/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(updates)
    })
  } catch (err) {
    console.warn('[Compliance] Failed to update job:', err)
  }
}

// CRP-BE-5: calculateNextRun and runDueJobs moved to server-side collector.
// The collector runs a 60-second interval that checks for due jobs and executes them.
// No browser tab required.

/**
 * Download report as file
 * @param {Object} report - The compliance report
 * @param {string} filename - Desired filename (without extension)
 * @param {Object} [opts]
 * @param {'json'|'pdf'} [opts.format='json'] - Output format
 */
export async function downloadReport(report, filename, opts = {}) {
  const { format = 'json' } = opts
  if (format === 'pdf') {
    return downloadReportAsPdf(report, filename)
  }
  const json = JSON.stringify(report, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = `${filename || `compliance-${report.format}-${Date.now()}`}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * AUD-PDF: POST the report to the collector's PDF renderer + download
 * the resulting application/pdf blob. WARD-signed manifest is embedded
 * in PDF Keywords metadata and echoed in the X-Quox-Manifest-Hash
 * header so callers can log provenance.
 */
async function downloadReportAsPdf(report, filename) {
  const resp = await fetch('/collector/api/v1/compliance/pdf', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: report.format, report, orgLabel: report.org_id || null }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }))
    throw new Error(err.error || `PDF download failed (${resp.status})`)
  }
  const blob = await resp.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename || `compliance-${report.format}-${Date.now()}`}.pdf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Export report as Markdown
 * @param {Object} report - The compliance report
 * @returns {string} Markdown content
 */
export function exportAsMarkdown(report) {
  const lines = [
    `# ${COMPLIANCE_FORMATS[report.format]?.name || report.framework || report.format} Compliance Report`,
    '',
  ]

  if (report.generatedAt) {
    lines.push(`**Generated:** ${new Date(report.generatedAt).toLocaleString()}`)
  }
  if (report.period?.start && report.period?.end) {
    lines.push(`**Period:** ${new Date(report.period.start).toLocaleDateString()} - ${new Date(report.period.end).toLocaleDateString()} (${report.period.days} days)`)
  }
  if (report.overallScore !== undefined) {
    lines.push(`**Overall Score:** ${report.overallScore}%`)
  }
  if (report.overallStatus) {
    lines.push(`**Overall Status:** ${report.overallStatus}`)
  }
  lines.push('')

  // Disclaimer — always surface prominently
  if (report.disclaimer) {
    lines.push('## Disclaimer', '', report.disclaimer, '')
  }

  // Posture statement
  if (report.postureStatement) {
    lines.push('## Posture Statement', '', report.postureStatement, '')
  }

  // Summary (legacy — from baseReport)
  if (report.summary) {
    lines.push('## Summary', '')
    if (report.summary.totalTraces !== undefined) lines.push(`- Total Traces: ${report.summary.totalTraces}`)
    if (report.summary.totalConversations !== undefined) lines.push(`- Conversations: ${report.summary.totalConversations}`)
    if (report.summary.totalLayerEvents !== undefined) lines.push(`- Layer Events: ${report.summary.totalLayerEvents}`)
    if (report.summary.uniqueAgents !== undefined) lines.push(`- Unique Agents: ${report.summary.uniqueAgents}`)
    lines.push('')
  }

  // Scope (SOC 2 + others)
  if (report.scope) {
    lines.push('## Scope', '')
    if (report.scope.systems) lines.push(`**Systems:** ${report.scope.systems}`)
    if (report.scope.period) lines.push(`**Period:** ${report.scope.period}`)
    if (report.scope.controls && Array.isArray(report.scope.controls)) {
      lines.push('**Controls in scope:**')
      for (const c of report.scope.controls) lines.push(`- ${c}`)
    }
    if (report.scope.methodology) lines.push('', `**Methodology:** ${report.scope.methodology}`)
    if (report.scope.exclusions) lines.push('', `**Exclusions:** ${report.scope.exclusions}`)
    lines.push('')
  }

  // Sections (controls)
  if (report.sections) {
    lines.push('## Sections', '')
    for (const [key, section] of Object.entries(report.sections)) {
      lines.push(`### ${section.name || key}`, '')
      if (section.description) lines.push(section.description, '')
      if (section.note) lines.push(`*${section.note}*`, '')
      if (section.controls) {
        for (const control of section.controls) {
          lines.push(`- **${control.id || control.ref || ''}**: ${control.name || control.standard || ''}`)
          if (control.status) lines.push(`  - Status: ${control.status}`)
          if (control.findings) lines.push(`  - Findings: ${truncate(control.findings, 240)}`)
          if (control.action_required) lines.push(`  - Action required: ${truncate(control.action_required, 240)}`)
          if (control.evidence && Array.isArray(control.evidence)) lines.push(`  - Evidence: ${control.evidence.length} items`)
          if (control.incidentResponse) {
            const ir = control.incidentResponse
            lines.push(`  - **Incident Response:**`)
            if (ir.detection) lines.push(`    - Detection: ${ir.detection.count} — ${ir.detection.description || ''}`)
            if (ir.triage) lines.push(`    - Triage: ${ir.triage.count} (${ir.triage.countLabel || 'count'}) — ${ir.triage.description || ''}`)
            if (ir.containment) lines.push(`    - Containment: ${ir.containment.count} (${ir.containment.countLabel || 'count'}) — ${ir.containment.description || ''}`)
            if (ir.recovery) lines.push(`    - Recovery: ${ir.recovery.count} (${ir.recovery.countLabel || 'count'}) — ${ir.recovery.description || ''}`)
          }
        }
        lines.push('')
      }
    }
  }

  // Management Attestation (SOC 2)
  if (report.attestation) {
    lines.push('## Management Attestation', '', report.attestation.text || '', '')
    if (Array.isArray(report.attestation.signature_fields)) {
      for (const sig of report.attestation.signature_fields) {
        lines.push(`**${sig.role}:** ____________________   Date: __________`)
      }
      lines.push('')
    }
  }

  // Type I vs Type II (SOC 2)
  if (report.typeGuidance) {
    lines.push('## Type I vs Type II Guidance', '')
    if (report.typeGuidance.typeI) lines.push(`**Type I:** ${report.typeGuidance.typeI}`)
    if (report.typeGuidance.typeII) lines.push(`**Type II:** ${report.typeGuidance.typeII}`)
    if (report.typeGuidance.recommendation) lines.push('', `**Recommendation:** ${report.typeGuidance.recommendation}`)
    lines.push('')
  }

  // GDPR Legal Basis Guidance
  if (report.legalBasisGuidance) {
    lines.push('## Legal Basis Guidance (Art.6)', '')
    if (report.legalBasisGuidance.note) lines.push(`*${report.legalBasisGuidance.note}*`, '')
    if (Array.isArray(report.legalBasisGuidance.availableBases)) {
      for (const b of report.legalBasisGuidance.availableBases) {
        lines.push(`- **${b.basis}** — ${b.guidance || ''}`)
      }
    }
    if (report.legalBasisGuidance.action_required) lines.push('', `**Action required:** ${report.legalBasisGuidance.action_required}`)
    lines.push('')
  }

  // GDPR ROPA Guidance
  if (report.ropaGuidance) {
    lines.push('## Records of Processing (ROPA — Art.30)', '')
    if (report.ropaGuidance.note) lines.push(`*${report.ropaGuidance.note}*`, '')
    if (Array.isArray(report.ropaGuidance.detectedProcessingActivities)) {
      lines.push(`**Detected processing activities:** ${report.ropaGuidance.detectedProcessingActivities.length}`)
    }
    if (report.ropaGuidance.action_required) lines.push('', `**Action required:** ${report.ropaGuidance.action_required}`)
    lines.push('')
  }

  // GDPR International Transfer Assessment
  if (report.internationalTransferAssessment) {
    const ita = report.internationalTransferAssessment
    lines.push('## International Transfer Assessment (Chapter V)', '')
    if (ita.note) lines.push(`${ita.note}`, '')
    if (Array.isArray(ita.detectedProviders) && ita.detectedProviders.length > 0) {
      lines.push('**Detected providers:**')
      for (const p of ita.detectedProviders) {
        lines.push(`- **${p.provider}** — Transfer mechanism: ${p.transferMechanism || 'unconfigured'}`)
      }
    }
    if (ita.action_required) lines.push('', `**Action required:** ${ita.action_required}`)
    lines.push('')
  }

  // GDPR Processor Assessment (Art.28)
  if (report.processorAssessment) {
    const pa = report.processorAssessment
    lines.push('## Processor Assessment (Art.28)', '')
    if (pa.note) lines.push(pa.note, '')
    if (Array.isArray(pa.detectedProcessors) && pa.detectedProcessors.length > 0) {
      lines.push('**Detected processors:**')
      for (const p of pa.detectedProcessors) {
        lines.push(`- **${p.provider}** — ${p.role || ''}`)
      }
      lines.push('')
    }
    if (Array.isArray(pa.dpaChecklist)) {
      lines.push('**DPA Checklist:**')
      for (const item of pa.dpaChecklist) lines.push(`- ${item}`)
    }
    if (pa.action_required) lines.push('', `**Action required:** ${pa.action_required}`)
    lines.push('')
  }

  // HIPAA BAA Assessment
  if (report.baaAssessment) {
    const ba = report.baaAssessment
    lines.push('## Business Associate Agreement Assessment (§164.314)', '')
    if (ba.note) lines.push(ba.note, '')
    if (Array.isArray(ba.detectedProviders) && ba.detectedProviders.length > 0) {
      lines.push('**Detected providers (potential Business Associates):**')
      for (const p of ba.detectedProviders) {
        lines.push(`- **${p.provider}** — ${p.possibleRole || 'role unspecified'}`)
      }
      lines.push('')
    }
    if (Array.isArray(ba.baaRequiredElements)) {
      lines.push('**Required BAA elements:**')
      for (const el of ba.baaRequiredElements) lines.push(`- ${el}`)
    }
    if (ba.action_required) lines.push('', `**Action required:** ${ba.action_required}`)
    lines.push('')
  }

  // HIPAA Addressable Guidance
  if (report.addressableGuidance) {
    const ag = report.addressableGuidance
    lines.push('## Addressable vs Required Guidance', '')
    if (ag.clarification) lines.push(ag.clarification, '')
    if (Array.isArray(ag.examples)) {
      lines.push('**Examples:**')
      for (const ex of ag.examples) lines.push(`- **${ex.spec}** — ${ex.typicalDecision}`)
    }
    if (ag.documentationRequirement) lines.push('', `**Documentation requirement:** ${ag.documentationRequirement}`)
    lines.push('')
  }

  // EU AI Act Operator Matrix
  if (report.operatorMatrix) {
    lines.push('## Operator Matrix — Obligations by Role', '')
    if (report.operatorMatrix.note) lines.push(`*${report.operatorMatrix.note}*`, '')
    for (const [role, details] of Object.entries(report.operatorMatrix)) {
      if (role === 'note') continue
      lines.push(`### ${role}`, '')
      if (details.definition) lines.push(`*${details.definition}*`, '')
      if (Array.isArray(details.obligations)) {
        lines.push('**Obligations:**')
        for (const ob of details.obligations) lines.push(`- ${ob}`)
      }
      lines.push('')
    }
  }

  // EU AI Act GPAI Obligations
  if (report.gpaiObligations) {
    const g = report.gpaiObligations
    lines.push('## GPAI Obligations (Art.52-56)', '')
    if (g.note) lines.push(g.note, '')
    if (g.standardGPAI?.obligations) {
      lines.push('**Standard GPAI (Art.53):**')
      for (const o of g.standardGPAI.obligations) lines.push(`- ${o}`)
      lines.push('')
    }
    if (g.systemicRiskGPAI?.obligations) {
      lines.push(`**Systemic Risk GPAI (Art.55):** ${g.systemicRiskGPAI.applies || ''}`)
      for (const o of g.systemicRiskGPAI.obligations) lines.push(`- ${o}`)
      lines.push('')
    }
    if (g.freeOpenSourceGPAI?.note) lines.push(`**FOSS GPAI:** ${g.freeOpenSourceGPAI.note}`, '')
  }

  // EU AI Act Universal Obligations
  if (report.universalObligations) {
    lines.push('## Universal Obligations (All AI Systems)', '')
    for (const [key, ob] of Object.entries(report.universalObligations)) {
      if (key === 'note') continue
      lines.push(`### ${key}`, '')
      if (ob.requirement) lines.push(ob.requirement, '')
      if (Array.isArray(ob.subsections)) {
        for (const s of ob.subsections) lines.push(`- **${s.sub}**: ${s.rule}`)
        lines.push('')
      }
      if (Array.isArray(ob.recommendations)) {
        lines.push('**Recommendations:**')
        for (const r of ob.recommendations) lines.push(`- ${r}`)
        lines.push('')
      }
    }
  }

  // EU AI Act QMS Requirements (Art.17)
  if (report.qmsRequirements) {
    lines.push('## Quality Management System Requirements (Art.17)', '')
    if (report.qmsRequirements.note) lines.push(report.qmsRequirements.note, '')
    if (Array.isArray(report.qmsRequirements.mandatoryElements)) {
      lines.push('**Mandatory elements:**')
      for (const el of report.qmsRequirements.mandatoryElements) lines.push(`- ${el}`)
      lines.push('')
    }
  }

  // EU AI Act Classification Memo Template
  if (report.classificationMemoTemplate) {
    const cmt = report.classificationMemoTemplate
    lines.push('## Classification Memo Template', '')
    if (cmt.note) lines.push(cmt.note, '')
    if (Array.isArray(cmt.recommendedSections)) {
      lines.push('**Recommended sections:**')
      for (const s of cmt.recommendedSections) lines.push(`- **${s.section}:** ${s.content}`)
      lines.push('')
    }
    if (cmt.retention) lines.push(`**Retention:** ${cmt.retention}`, '')
  }

  // ISO 42001 AI System Lifecycle Record guidance
  if (report.aiSystemLifecycleRecordGuidance) {
    const asl = report.aiSystemLifecycleRecordGuidance
    lines.push('## AI System Lifecycle Record (ASL) Guidance', '')
    if (asl.note) lines.push(asl.note, '')
    if (Array.isArray(asl.recommendedFields)) {
      lines.push('**Recommended fields:**')
      for (const f of asl.recommendedFields) lines.push(`- ${f}`)
      lines.push('')
    }
    if (asl.retention) lines.push(`**Retention:** ${asl.retention}`, '')
  }

  // NIST AI RMF AI System Profile
  if (report.aiSystemProfile) {
    lines.push('## AI System Profile', '')
    const prof = report.aiSystemProfile
    if (prof.system_name) {
      lines.push(`**System name:** ${prof.system_name}`)
      if (prof.intended_use) lines.push(`**Intended use:** ${prof.intended_use}`)
      if (prof.risk_tier) lines.push(`**Risk tier:** ${prof.risk_tier}`)
      if (Array.isArray(prof.affected_parties)) lines.push(`**Affected parties:** ${prof.affected_parties.join(', ')}`)
      if (prof.context) lines.push(`**Context:** ${prof.context}`)
    } else if (prof.note) {
      lines.push(prof.note)
    }
    lines.push('')
  }

  // NIST AI RMF Cross-References
  if (report.crossReferences) {
    const cr = report.crossReferences
    lines.push('## Cross-References to Other Frameworks', '')
    if (cr.note) lines.push(cr.note, '')
    if (Array.isArray(cr.mappings)) {
      for (const m of cr.mappings) {
        lines.push(`- **${m.function}** maps to: ${m.mapsTo}`)
      }
      lines.push('')
    }
  }

  // VOLT Evidence Bundle Verification
  if (report.voltEvidence) {
    const ve = report.voltEvidence
    lines.push('## VOLT Evidence Bundle Verification', '')
    if (ve.total_runs !== undefined) lines.push(`- Total VOLT Runs: ${ve.total_runs}`)
    if (ve.verified_sample !== undefined) lines.push(`- Verified Sample: ${ve.verified_sample}`)
    if (ve.valid_count !== undefined && ve.verified_sample !== undefined) {
      lines.push(`- Valid: ${ve.valid_count}/${ve.verified_sample} (${ve.integrity_rate}%)`)
    } else if (ve.integrity_rate !== undefined) {
      lines.push(`- Chain integrity: ${ve.integrity_rate}%`)
    }
    lines.push('')
  }

  // Risk assessment guidance (HIPAA)
  if (report.riskAssessmentGuidance) {
    lines.push('## Risk Assessment Guidance', '')
    const rag = report.riskAssessmentGuidance
    if (rag.note) lines.push(rag.note, '')
    if (rag.action_required) lines.push(`**Action required:** ${rag.action_required}`, '')
  }

  return lines.join('\n')
}

function truncate(str, max) {
  if (!str) return ''
  const s = String(str)
  return s.length > max ? s.slice(0, max) + '…' : s
}

export default {
  COMPLIANCE_FORMATS,
  generateComplianceReport,
  getReportHistory,
  scheduleComplianceJob,
  getScheduledJobs,
  cancelScheduledJob,
  updateScheduledJob,
  downloadReport,
  exportAsMarkdown
}
