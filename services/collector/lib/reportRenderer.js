/**
 * Report Renderer — Auditor-grade compliance report generation
 *
 * Renders framework-specific reports from formatter output into structured
 * HTML (for in-app preview + print-to-PDF) and Markdown (for export).
 * Supports 3 redaction levels: internal, external, public.
 *
 * AUD-UX Phase 5
 */

function escapeHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const REDACTION_LEVELS = {
  internal: { label: 'Internal', description: 'Full detail, all evidence, no redaction' },
  external: { label: 'External', description: 'Secrets stripped, IPs redacted, sample evidence only' },
  public: { label: 'Public', description: 'Executive summary only, no evidence samples' },
}

const REPORT_SECTIONS = [
  'cover',
  'executive_summary',
  'scope',
  'methodology',
  'findings',
  'appendix_evidence',
  'appendix_attestation',
  'appendix_glossary',
]

const FRAMEWORK_TITLES = {
  soc2: 'SOC 2 Type II Readiness Assessment',
  gdpr: 'GDPR Compliance Assessment',
  hipaa: 'HIPAA Security Risk Assessment',
  iso27001: 'ISO 27001 Readiness Assessment',
  euAiAct: 'EU AI Act Conformity Assessment',
}

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/g,
  /password\s*[=:]\s*\S+/gi,
  /secret\s*[=:]\s*\S+/gi,
  /api[_-]?key\s*[=:]\s*\S+/gi,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END/g,
]

const IP_PATTERN = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g

function redactText(text, level) {
  if (!text || level === 'internal') return text
  let result = text
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]')
  }
  if (level === 'external' || level === 'public') {
    result = result.replace(IP_PATTERN, '[INTERNAL-IP]')
  }
  return result
}

function redactEvidence(evidence, level) {
  if (level === 'internal') return evidence
  if (level === 'public') return []
  if (!Array.isArray(evidence)) return []
  return evidence.slice(0, 3).map(e => ({
    ...e,
    payload: e.payload ? redactText(typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload).slice(0, 200), level) : undefined,
  }))
}

function buildReportMetadata(framework, orgName, period, options = {}) {
  const now = new Date()
  return {
    title: FRAMEWORK_TITLES[framework] || `${framework} Compliance Report`,
    organisation: orgName || '[Organisation Name]',
    framework,
    period_start: period?.start || null,
    period_end: period?.end || now.toISOString().split('T')[0],
    generated_at: now.toISOString(),
    version: options.version || '1.0',
    classification: options.classification || 'CONFIDENTIAL',
    redaction_level: options.redaction || 'internal',
    document_id: `RPT-${framework.toUpperCase()}-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${Math.random().toString(36).slice(2, 6)}`,
  }
}

function renderCoverPage(metadata) {
  return {
    section: 'cover',
    content: {
      title: metadata.title,
      organisation: metadata.organisation,
      period: metadata.period_start
        ? `${metadata.period_start} to ${metadata.period_end}`
        : `As of ${metadata.period_end}`,
      generated: metadata.generated_at.split('T')[0],
      version: metadata.version,
      classification: metadata.classification,
      document_id: metadata.document_id,
    },
  }
}

function renderExecutiveSummary(formatterOutput, metadata) {
  const overall = formatterOutput?.overallScore ?? formatterOutput?.score ?? 0
  const status = formatterOutput?.overallStatus || formatterOutput?.status || 'unknown'
  const controlCount = formatterOutput?.sections?.length || formatterOutput?.controls?.length || 0
  const compliantCount = (formatterOutput?.sections || formatterOutput?.controls || [])
    .filter(s => s.status === 'compliant').length

  return {
    section: 'executive_summary',
    content: {
      overall_score: Math.round(overall),
      overall_status: status,
      controls_assessed: controlCount,
      controls_compliant: compliantCount,
      framework: metadata.framework,
      period: metadata.period_start
        ? `${metadata.period_start} to ${metadata.period_end}`
        : `As of ${metadata.period_end}`,
      key_findings: formatterOutput?.keyFindings || formatterOutput?.recommendations || [],
    },
  }
}

function renderScope(metadata, systemDescription = '') {
  return {
    section: 'scope',
    content: {
      systems: systemDescription || '[Systems in scope — to be completed by management]',
      period: metadata.period_start
        ? `${metadata.period_start} to ${metadata.period_end}`
        : `Point-in-time assessment as of ${metadata.period_end}`,
      framework: metadata.title,
      methodology: 'Automated evidence collection from AOCL governance layers, VOLT verifiable operations ledger, AEE audit envelope exchange, and WARD write-once receipt digests. Controls mapped to framework requirements via evidenceMapping.js.',
      exclusions: '[Controls excluded from scope — to be documented]',
    },
  }
}

function renderFindings(formatterOutput, redactionLevel) {
  const sections = formatterOutput?.sections || formatterOutput?.controls || []
  return {
    section: 'findings',
    content: {
      controls: sections.map(s => ({
        id: redactText(s.id || s.control_id || s.name, redactionLevel),
        name: redactText(s.name || s.title || s.id, redactionLevel),
        status: s.status,
        score: s.score,
        evidence_count: s.evidenceCount || s.evidence_count || 0,
        details: redactText(s.details || s.description || '', redactionLevel),
        recommendations: (s.recommendations || s.gaps || []).map(r => typeof r === 'string' ? redactText(r, redactionLevel) : r),
        evidence_samples: redactEvidence(s.evidenceSamples || [], redactionLevel),
      })),
    },
  }
}

function renderAppendixEvidence(formatterOutput, redactionLevel) {
  if (redactionLevel === 'public') {
    return { section: 'appendix_evidence', content: { items: [], note: 'Evidence samples excluded from public report.' } }
  }
  const samples = formatterOutput?.evidenceSamples || []
  return {
    section: 'appendix_evidence',
    content: {
      items: redactEvidence(samples, redactionLevel),
    },
  }
}

function renderAppendixAttestation(metadata) {
  return {
    section: 'appendix_attestation',
    content: {
      text: `This report was generated by the ${metadata.organisation} governance platform on ${metadata.generated_at.split('T')[0]}. Management is responsible for the design, implementation, and maintenance of controls. This assessment is a technical readiness evaluation, not a legal compliance declaration. Consult qualified legal counsel and accredited auditors for formal certification.`,
      signature_fields: [
        { role: 'Prepared by', name: '', date: '' },
        { role: 'Reviewed by', name: '', date: '' },
        { role: 'Approved by', name: '', date: '' },
      ],
    },
  }
}

function renderAppendixGlossary() {
  return {
    section: 'appendix_glossary',
    content: {
      terms: [
        { term: 'AEE', definition: 'Agent Envelope Exchange — structured audit trail for agent-to-agent communication' },
        { term: 'AOCL', definition: 'Agent Orchestration Control Layers — 11-layer governance stack (L0-L10)' },
        { term: 'VOLT', definition: 'Verifiable Operations Ledger & Trace — cryptographic hash chain of all operations' },
        { term: 'WARD', definition: 'Write-once Append-only Receipt Digests — tamper-evident witness chain with external timestamping' },
        { term: 'HITL', definition: 'Human-in-the-Loop — approval workflow requiring human authorization' },
        { term: 'SoA', definition: 'Statement of Applicability — ISO 27001 document listing all controls and their applicability' },
        { term: 'DPIA', definition: 'Data Protection Impact Assessment — GDPR Art.35 risk assessment for high-risk processing' },
      ],
    },
  }
}

function renderReport(framework, formatterOutput, options = {}) {
  const metadata = buildReportMetadata(
    framework,
    options.orgName,
    options.period,
    { version: options.version, classification: options.classification, redaction: options.redaction }
  )

  const sections = [
    renderCoverPage(metadata),
    renderExecutiveSummary(formatterOutput, metadata),
    renderScope(metadata, options.systemDescription),
    renderFindings(formatterOutput, metadata.redaction_level),
    renderAppendixEvidence(formatterOutput, metadata.redaction_level),
    renderAppendixAttestation(metadata),
    renderAppendixGlossary(),
  ]

  return { metadata, sections }
}

function renderReportMarkdown(report) {
  const { metadata, sections } = report
  const lines = []

  for (const section of sections) {
    switch (section.section) {
      case 'cover':
        lines.push(`# ${section.content.title}`, '')
        lines.push(`**Organisation:** ${section.content.organisation}`)
        lines.push(`**Period:** ${section.content.period}`)
        lines.push(`**Generated:** ${section.content.generated}`)
        lines.push(`**Version:** ${section.content.version}`)
        lines.push(`**Classification:** ${section.content.classification}`)
        lines.push(`**Document ID:** ${section.content.document_id}`)
        lines.push('', '---', '')
        break

      case 'executive_summary':
        lines.push(`## Executive Summary`, '')
        lines.push(`**Overall Score:** ${section.content.overall_score}%`)
        lines.push(`**Status:** ${section.content.overall_status}`)
        lines.push(`**Controls Assessed:** ${section.content.controls_assessed}`)
        lines.push(`**Controls Compliant:** ${section.content.controls_compliant}`)
        if (section.content.key_findings.length > 0) {
          lines.push('', '**Key Findings:**')
          for (const f of section.content.key_findings) {
            lines.push(`- ${typeof f === 'string' ? f : f.text || f.description || JSON.stringify(f)}`)
          }
        }
        lines.push('')
        break

      case 'scope':
        lines.push(`## Scope`, '')
        lines.push(`**Systems:** ${section.content.systems}`)
        lines.push(`**Period:** ${section.content.period}`)
        lines.push(`**Framework:** ${section.content.framework}`)
        lines.push(`**Methodology:** ${section.content.methodology}`)
        lines.push(`**Exclusions:** ${section.content.exclusions}`)
        lines.push('')
        break

      case 'findings':
        lines.push(`## Findings`, '')
        lines.push(`| Control | Status | Score | Evidence |`)
        lines.push(`|---------|--------|-------|----------|`)
        for (const c of section.content.controls) {
          lines.push(`| ${c.id} — ${c.name} | ${c.status} | ${c.score ?? '—'} | ${c.evidence_count} items |`)
        }
        lines.push('')
        break

      case 'appendix_evidence':
        lines.push(`## Appendix A: Evidence Samples`, '')
        if (section.content.note) {
          lines.push(section.content.note)
        } else if (section.content.items.length === 0) {
          lines.push('No evidence samples included in this report.')
        } else {
          for (const item of section.content.items) {
            lines.push(`- **${item.id || 'Event'}** (${item.ts || '—'}): ${item.payload || '—'}`)
          }
        }
        lines.push('')
        break

      case 'appendix_attestation':
        lines.push(`## Appendix B: Management Attestation`, '')
        lines.push(section.content.text)
        lines.push('')
        for (const sig of section.content.signature_fields) {
          lines.push(`**${sig.role}:** _________________________ Date: _________`)
        }
        lines.push('')
        break

      case 'appendix_glossary':
        lines.push(`## Appendix C: Glossary`, '')
        for (const t of section.content.terms) {
          lines.push(`- **${t.term}** — ${t.definition}`)
        }
        lines.push('')
        break
    }
  }

  lines.push('---', '')
  lines.push(`*This report is a technical readiness assessment, not a legal compliance declaration. Consult qualified legal counsel for formal certification.*`)

  return lines.join('\n')
}

function renderReportHtml(report) {
  const { metadata, sections } = report
  const md = renderReportMarkdown(report)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(metadata.title)} — ${escapeHtml(metadata.organisation)}</title>
<style>
@media print {
  .no-print { display: none; }
  .page-break { page-break-before: always; }
  table { page-break-inside: avoid; }
  h2, h3 { page-break-after: avoid; }
}
body { font-family: 'Inter', system-ui, sans-serif; color: #1a1a2e; line-height: 1.6; max-width: 794px; margin: 0 auto; padding: 40px; }
h1 { font-size: 24px; border-bottom: 2px solid #1a1a2e; padding-bottom: 8px; }
h2 { font-size: 18px; margin-top: 32px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; }
th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; font-size: 13px; }
th { background: #f5f5f5; font-weight: 600; }
tr:nth-child(even) { background: #fafafa; }
.cover { text-align: center; padding: 80px 0; }
.cover h1 { font-size: 28px; border: none; }
.classification { font-size: 11px; font-weight: 700; letter-spacing: 2px; color: #c00; text-transform: uppercase; margin-top: 40px; }
.meta { font-size: 12px; color: #666; }
.status-compliant { color: #16a34a; font-weight: 600; }
.status-partial { color: #d97706; font-weight: 600; }
.status-gap, .status-non-compliant { color: #dc2626; font-weight: 600; }
footer { font-size: 10px; color: #999; text-align: center; margin-top: 40px; padding-top: 12px; border-top: 1px solid #eee; }
</style>
</head>
<body>
<div class="cover page-break">
  <h1>${escapeHtml(metadata.title)}</h1>
  <p style="font-size:18px; margin-top:24px;">${escapeHtml(metadata.organisation)}</p>
  <p class="meta">${escapeHtml(metadata.period_start ? metadata.period_start + ' to ' + metadata.period_end : 'As of ' + metadata.period_end)}</p>
  <p class="meta">Generated: ${metadata.generated_at.split('T')[0]} | Version ${metadata.version}</p>
  <p class="meta">Document ID: ${metadata.document_id}</p>
  <p class="classification">${escapeHtml(metadata.classification)}</p>
</div>
${sections.filter(s => s.section !== 'cover').map(s => {
  if (s.section === 'findings') {
    return `<div class="page-break"><h2>Findings</h2>
<table><thead><tr><th>Control</th><th>Status</th><th>Score</th><th>Evidence</th></tr></thead><tbody>
${s.content.controls.map(c => `<tr><td>${escapeHtml(c.id)} — ${escapeHtml(c.name)}</td><td class="status-${escapeHtml(c.status)}">${escapeHtml(c.status)}</td><td>${c.score ?? '—'}</td><td>${c.evidence_count} items</td></tr>`).join('\n')}
</tbody></table></div>`
  }
  if (s.section === 'executive_summary') {
    return `<div class="page-break"><h2>Executive Summary</h2>
<p><strong>Overall Score:</strong> ${s.content.overall_score}% | <strong>Status:</strong> ${s.content.overall_status}</p>
<p><strong>Controls:</strong> ${s.content.controls_compliant}/${s.content.controls_assessed} compliant</p>
${s.content.key_findings.length > 0 ? '<h3>Key Findings</h3><ul>' + s.content.key_findings.map(f => `<li>${typeof f === 'string' ? f : f.text || ''}</li>`).join('') + '</ul>' : ''}
</div>`
  }
  if (s.section === 'scope') {
    return `<div class="page-break"><h2>Scope</h2>
<p><strong>Systems:</strong> ${s.content.systems}</p>
<p><strong>Period:</strong> ${s.content.period}</p>
<p><strong>Methodology:</strong> ${s.content.methodology}</p></div>`
  }
  if (s.section === 'appendix_attestation') {
    return `<div class="page-break"><h2>Appendix B: Management Attestation</h2><p>${s.content.text}</p>
${s.content.signature_fields.map(f => `<p><strong>${f.role}:</strong> _________________________ Date: _________</p>`).join('\n')}</div>`
  }
  if (s.section === 'appendix_glossary') {
    return `<div class="page-break"><h2>Appendix C: Glossary</h2><dl>
${s.content.terms.map(t => `<dt><strong>${t.term}</strong></dt><dd>${t.definition}</dd>`).join('\n')}</dl></div>`
  }
  return ''
}).join('\n')}
<footer>Page generated by Quox Governance Platform | ${metadata.document_id} | ${metadata.classification}</footer>
</body>
</html>`
}

module.exports = {
  REDACTION_LEVELS,
  REPORT_SECTIONS,
  FRAMEWORK_TITLES,
  redactText,
  redactEvidence,
  buildReportMetadata,
  renderReport,
  renderReportMarkdown,
  renderReportHtml,
}
