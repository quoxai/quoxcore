/**
 * Continuous Compliance Monitor — Real-time posture, drift detection, gap analysis
 *
 * Server-side computation of compliance posture across all frameworks.
 * Drift alerts when evidence goes stale. Cross-framework gap heatmap.
 *
 * AUD-UX Phase 8
 */

const DEFAULT_DRIFT_THRESHOLD_DAYS = 90

const CONTROL_DOMAINS = [
  { id: 'access_control', label: 'Access Control', frameworks: { soc2: ['CC6.1', 'CC6.2', 'CC6.3'], iso27001: ['A.8.2', 'A.8.3', 'A.8.5'], hipaa: ['164.312(a)(1)', '164.312(a)(2)(i)', '164.312(d)'] } },
  { id: 'monitoring', label: 'Monitoring & Logging', frameworks: { soc2: ['CC7.1', 'CC7.2'], iso27001: ['A.8.15', 'A.8.16'], hipaa: ['164.312(b)'] } },
  { id: 'change_mgmt', label: 'Change Management', frameworks: { soc2: ['CC7.3', 'CC8.1'], iso27001: ['A.8.9'] } },
  { id: 'incident', label: 'Incident Response', frameworks: { soc2: ['CC7.4'], gdpr: ['Art.33', 'Art.34'] } },
  { id: 'encryption', label: 'Encryption & Integrity', frameworks: { soc2: ['PI1.5'], hipaa: ['164.312(c)(1)', '164.312(c)(3)'] } },
  { id: 'risk_mgmt', label: 'Risk Management', frameworks: { iso27001: ['A.5.7'], euAiAct: ['Art.9'] } },
  { id: 'human_oversight', label: 'Human Oversight', frameworks: { euAiAct: ['Art.14'] } },
  { id: 'transparency', label: 'Transparency & Documentation', frameworks: { euAiAct: ['Art.13'], gdpr: ['Art.5(1)(a)'] } },
  { id: 'data_protection', label: 'Data Protection & Privacy', frameworks: { gdpr: ['Art.5(1)(c)', 'Art.32(1)(a)', 'Art.32(1)(b)'], hipaa: ['164.312(e)(1)'] } },
  { id: 'continuity', label: 'Business Continuity', frameworks: { soc2: ['A1.1', 'A1.2', 'A1.3'] } },
]

function computePosture(controlStatuses) {
  if (!controlStatuses || controlStatuses.length === 0) {
    return { score: 0, total: 0, compliant: 0, partial: 0, gap: 0, notAssessed: 0 }
  }

  let compliant = 0, partial = 0, gap = 0, notAssessed = 0
  for (const s of controlStatuses) {
    if (s.status === 'compliant' || s.status === 'evidenced') compliant++
    else if (s.status === 'partial') partial++
    else if (s.status === 'gap' || s.status === 'non-compliant') gap++
    else notAssessed++
  }

  const assessed = compliant + partial + gap
  const score = assessed > 0 ? Math.round(((compliant + partial * 0.5) / assessed) * 100) : 0

  return { score, total: controlStatuses.length, compliant, partial, gap, notAssessed }
}

function detectDrift(controlStatuses, thresholdDays = DEFAULT_DRIFT_THRESHOLD_DAYS) {
  const now = Date.now()
  const thresholdMs = thresholdDays * 86400000
  const alerts = []

  for (const ctrl of controlStatuses) {
    if (!ctrl.lastEvidenceDate) {
      alerts.push({ controlId: ctrl.controlId, framework: ctrl.framework, type: 'no_evidence', message: `No evidence recorded for ${ctrl.controlId}` })
      continue
    }

    const age = now - new Date(ctrl.lastEvidenceDate).getTime()
    if (age > thresholdMs) {
      const daysSince = Math.floor(age / 86400000)
      alerts.push({
        controlId: ctrl.controlId,
        framework: ctrl.framework,
        type: 'stale',
        daysSince,
        message: `${ctrl.controlId} evidence is ${daysSince} days old (threshold: ${thresholdDays}d)`,
      })
    }
  }

  return alerts
}

function buildGapHeatmap(controlStatuses) {
  const heatmap = []

  for (const domain of CONTROL_DOMAINS) {
    const row = { domain: domain.id, label: domain.label, cells: {} }

    for (const [fwId, controlIds] of Object.entries(domain.frameworks)) {
      const domainControls = controlStatuses.filter(c => c.framework === fwId && controlIds.includes(c.controlId))

      if (domainControls.length === 0) {
        row.cells[fwId] = { status: 'not_applicable', score: null }
        continue
      }

      const compliant = domainControls.filter(c => c.status === 'compliant' || c.status === 'evidenced').length
      const ratio = compliant / domainControls.length

      if (ratio >= 0.9) row.cells[fwId] = { status: 'green', score: Math.round(ratio * 100) }
      else if (ratio >= 0.5) row.cells[fwId] = { status: 'amber', score: Math.round(ratio * 100) }
      else if (ratio > 0) row.cells[fwId] = { status: 'red', score: Math.round(ratio * 100) }
      else row.cells[fwId] = { status: 'red', score: 0 }
    }

    heatmap.push(row)
  }

  return heatmap
}

function computeFrameworkSummaries(controlStatuses) {
  const frameworks = {}

  for (const ctrl of controlStatuses) {
    if (!frameworks[ctrl.framework]) {
      frameworks[ctrl.framework] = { framework: ctrl.framework, controls: [] }
    }
    frameworks[ctrl.framework].controls.push(ctrl)
  }

  return Object.values(frameworks).map(fw => ({
    framework: fw.framework,
    posture: computePosture(fw.controls),
  }))
}

module.exports = {
  DEFAULT_DRIFT_THRESHOLD_DAYS,
  CONTROL_DOMAINS,
  computePosture,
  detectDrift,
  buildGapHeatmap,
  computeFrameworkSummaries,
}
