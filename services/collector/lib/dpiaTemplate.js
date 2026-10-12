/**
 * DPIA Template Engine — GDPR Article 35
 *
 * Structured Data Protection Impact Assessment with 6 mandatory sections,
 * risk register with 5×5 scoring matrix, and markdown export.
 *
 * AUD-UX Phase 3
 */

const DPIA_SECTIONS = [
  { id: 'description', label: '1. Processing Description', required: true },
  { id: 'necessity', label: '2. Necessity & Proportionality', required: true },
  { id: 'risks', label: '3. Risk Assessment', required: true },
  { id: 'measures', label: '4. Mitigation Measures', required: true },
  { id: 'consultation', label: '5. Consultation', required: true },
  { id: 'outcome', label: '6. Outcome & Decision', required: true },
]

const LIFECYCLE_STATES = ['draft', 'dpo_review', 'approved', 'prior_consultation_required']

const VALID_TRANSITIONS = {
  draft: ['dpo_review'],
  dpo_review: ['approved', 'prior_consultation_required', 'draft'],
  approved: ['draft', 'prior_consultation_required'],
  prior_consultation_required: ['draft', 'dpo_review'],
}

const LEGAL_BASES = [
  { id: 'consent', label: 'Consent (Art.6(1)(a))' },
  { id: 'contract', label: 'Performance of a contract (Art.6(1)(b))' },
  { id: 'legal_obligation', label: 'Legal obligation (Art.6(1)(c))' },
  { id: 'vital_interests', label: 'Vital interests (Art.6(1)(d))' },
  { id: 'public_interest', label: 'Public interest (Art.6(1)(e))' },
  { id: 'legitimate_interest', label: 'Legitimate interest (Art.6(1)(f))' },
]

const DATA_CATEGORIES = [
  'Personal identification data',
  'Financial data',
  'Employment data',
  'Health data (special category)',
  'Biometric data (special category)',
  'Location data',
  'Online identifiers',
  'Communication content',
  'Behavioural/profiling data',
  'Criminal conviction data',
]

const DATA_SUBJECT_CATEGORIES = [
  'Employees',
  'Customers',
  'Contractors',
  'Job applicants',
  'Website visitors',
  'End users',
  'Minors',
  'Patients',
  'Citizens/residents',
]

function createBlankDpia(orgId = '', processingName = '') {
  return {
    org_id: orgId,
    processing_name: processingName,
    status: 'draft',
    version: 1,
    sections: {
      description: {
        controller_name: '',
        dpo_name: '',
        dpo_contact: '',
        system_name: '',
        processing_purpose: '',
        legal_basis: null,
        legitimate_interest_assessment: '',
        data_categories: [],
        special_categories: false,
        data_subjects: [],
        recipients: [],
        retention_period: '',
        international_transfers: [],
      },
      necessity: {
        purpose_limitation: '',
        data_minimisation: '',
        proportionality_assessment: '',
        alternatives_considered: '',
      },
      risks: [],
      measures: [],
      consultation: {
        dpo_consulted: false,
        dpo_consultation_date: null,
        dpo_opinion: '',
        data_subjects_consulted: false,
        data_subject_consultation_method: '',
        data_subject_consultation_outcome: '',
      },
      outcome: {
        overall_risk_level: null,
        decision: null,
        prior_consultation_required: false,
        prior_consultation_reason: '',
        approved_by: '',
        approved_date: null,
      },
    },
  }
}

function createRisk(name = '') {
  return {
    id: `RISK_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    description: '',
    threat_type: '',
    likelihood: 0,
    severity: 0,
    inherent_risk: 0,
    existing_controls: '',
    residual_likelihood: 0,
    residual_severity: 0,
    residual_risk: 0,
  }
}

function createMeasure(riskId = '') {
  return {
    id: `MEAS_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    risk_id: riskId,
    description: '',
    type: '',
    responsible: '',
    target_date: null,
    status: 'planned',
  }
}

function computeRiskScore(likelihood, severity) {
  return likelihood * severity
}

function getRiskLevel(score) {
  if (score >= 16) return { level: 'critical', label: 'Critical', color: '#ef4444' }
  if (score >= 9) return { level: 'high', label: 'High', color: '#f97316' }
  if (score >= 4) return { level: 'medium', label: 'Medium', color: '#f59e0b' }
  if (score >= 1) return { level: 'low', label: 'Low', color: '#30ff90' }
  return { level: 'none', label: 'Not Assessed', color: 'rgba(255,255,255,0.4)' }
}

function computeSectionCompleteness(dpia) {
  const s = dpia.sections
  const results = {}

  // Description: need controller, purpose, legal basis, at least 1 data category
  const desc = s.description
  const descFields = [desc.controller_name, desc.processing_purpose, desc.legal_basis, desc.data_categories.length > 0]
  results.description = { complete: descFields.filter(Boolean).length, total: descFields.length }

  // Necessity: need purpose limitation and proportionality
  const nec = s.necessity
  const necFields = [nec.purpose_limitation, nec.proportionality_assessment]
  results.necessity = { complete: necFields.filter(Boolean).length, total: necFields.length }

  // Risks: at least 1 risk with scores
  const risksScored = s.risks.filter(r => r.likelihood > 0 && r.severity > 0)
  results.risks = { complete: risksScored.length > 0 ? 1 : 0, total: 1 }

  // Measures: at least 1 measure for each high/critical risk
  const highRisks = s.risks.filter(r => computeRiskScore(r.likelihood, r.severity) >= 9)
  const mitigated = highRisks.filter(hr => s.measures.some(m => m.risk_id === hr.id))
  results.measures = { complete: highRisks.length === 0 ? 1 : mitigated.length, total: highRisks.length || 1 }

  // Consultation: DPO consulted
  results.consultation = { complete: s.consultation.dpo_consulted ? 1 : 0, total: 1 }

  // Outcome: decision made
  results.outcome = { complete: s.outcome.decision ? 1 : 0, total: 1 }

  return results
}

function isValidTransition(from, to) {
  const valid = VALID_TRANSITIONS[from]
  return valid ? valid.includes(to) : false
}

function generateDpiaMarkdown(dpia) {
  const s = dpia.sections
  const lines = [
    `# Data Protection Impact Assessment`,
    ``,
    `**Processing Activity:** ${dpia.processing_name || '[Not specified]'}`,
    `**Controller:** ${s.description.controller_name || '[Not specified]'}`,
    `**DPO:** ${s.description.dpo_name || '[Not specified]'}`,
    `**Status:** ${dpia.status}`,
    `**Version:** ${dpia.version}`,
    `**Date:** ${new Date().toISOString().split('T')[0]}`,
    ``,
    `---`,
    ``,
    `## 1. Processing Description`,
    ``,
    `**Purpose:** ${s.description.processing_purpose || '[Not specified]'}`,
    `**Legal Basis:** ${s.description.legal_basis ? LEGAL_BASES.find(b => b.id === s.description.legal_basis)?.label || s.description.legal_basis : '[Not specified]'}`,
    `**Data Categories:** ${s.description.data_categories.length > 0 ? s.description.data_categories.join(', ') : '[Not specified]'}`,
    `**Data Subjects:** ${s.description.data_subjects.length > 0 ? s.description.data_subjects.join(', ') : '[Not specified]'}`,
    `**Retention Period:** ${s.description.retention_period || '[Not specified]'}`,
  ]

  if (s.description.international_transfers.length > 0) {
    lines.push(`**International Transfers:** ${s.description.international_transfers.join(', ')}`)
  }

  lines.push(``, `## 2. Necessity & Proportionality`, ``)
  lines.push(`**Purpose Limitation:** ${s.necessity.purpose_limitation || '[Not assessed]'}`)
  lines.push(`**Proportionality:** ${s.necessity.proportionality_assessment || '[Not assessed]'}`)

  lines.push(``, `## 3. Risk Assessment`, ``)
  if (s.risks.length === 0) {
    lines.push(`No risks identified yet.`)
  } else {
    lines.push(`| Risk | Likelihood | Severity | Score | Level |`)
    lines.push(`|------|-----------|----------|-------|-------|`)
    for (const r of s.risks) {
      const score = computeRiskScore(r.likelihood, r.severity)
      const level = getRiskLevel(score)
      lines.push(`| ${r.name || '[Unnamed]'} | ${r.likelihood}/5 | ${r.severity}/5 | ${score}/25 | ${level.label} |`)
    }
  }

  lines.push(``, `## 4. Mitigation Measures`, ``)
  if (s.measures.length === 0) {
    lines.push(`No measures defined yet.`)
  } else {
    for (const m of s.measures) {
      const risk = s.risks.find(r => r.id === m.risk_id)
      lines.push(`- **${m.description || '[Unnamed measure]'}** (for: ${risk?.name || 'general'}) — ${m.status}`)
    }
  }

  lines.push(``, `## 5. Consultation`, ``)
  lines.push(`**DPO Consulted:** ${s.consultation.dpo_consulted ? 'Yes' : 'No'}`)
  if (s.consultation.dpo_consulted) {
    lines.push(`**DPO Opinion:** ${s.consultation.dpo_opinion || '[Pending]'}`)
  }

  lines.push(``, `## 6. Outcome`, ``)
  lines.push(`**Overall Risk Level:** ${s.outcome.overall_risk_level || '[Not determined]'}`)
  lines.push(`**Decision:** ${s.outcome.decision || '[Pending]'}`)
  if (s.outcome.prior_consultation_required) {
    lines.push(`**Prior Consultation Required:** Yes — ${s.outcome.prior_consultation_reason}`)
  }

  lines.push(``, `---`, ``)
  lines.push(`*This DPIA is a technical assessment. It does not constitute legal advice. Consult qualified legal counsel and your Data Protection Officer.*`)

  return lines.join('\n')
}

module.exports = {
  DPIA_SECTIONS,
  LIFECYCLE_STATES,
  VALID_TRANSITIONS,
  LEGAL_BASES,
  DATA_CATEGORIES,
  DATA_SUBJECT_CATEGORIES,
  createBlankDpia,
  createRisk,
  createMeasure,
  computeRiskScore,
  getRiskLevel,
  computeSectionCompleteness,
  isValidTransition,
  generateDpiaMarkdown,
}
