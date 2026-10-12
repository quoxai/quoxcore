/**
 * AUDITUS Context Injection — CRP-QXFY-4
 *
 * Builds view-aware context strings that get injected into AUDITUS's
 * system prompt via ChatTab's additionalContext prop. This gives AUDITUS
 * visibility into what the user is seeing on the /compliance page —
 * which tab is active, what data is displayed, what was clicked.
 *
 * Context is kept under ~2000 tokens to avoid bloating the prompt.
 */

const FORMAT_NAMES = {
  soc2: 'SOC 2', hipaa: 'HIPAA', gdpr: 'GDPR',
  iso27001: 'ISO 27001', euAiAct: 'EU AI Act',
  iso42001: 'ISO 42001', nistAiRmf: 'NIST AI RMF',
  json: 'JSON',
}

/**
 * Build the full context string for AUDITUS based on active tab and data.
 *
 * @param {string} activeTab - Current tab: posture|frameworks|reports|evidence|certification
 * @param {Object} data - All compliance data from useComplianceData
 * @param {Object|null} investigation - Click-triggered investigation { type, subject, data }
 * @returns {string} Context to inject into system prompt
 */
export function buildAuditusContext(activeTab, data, investigation = null) {
  const sections = []

  sections.push('## AUDITUS — Live Compliance Page Context')
  sections.push(`The user is currently viewing the /compliance page, **${activeTab.toUpperCase()}** tab.`)
  sections.push('You can see exactly what the user sees. Reference this data directly — do NOT re-query with tools unless the user asks for fresh data.')

  // Always include posture summary (compact)
  if (data.posture) {
    const p = data.posture
    sections.push(`\n### Posture Summary`)
    sections.push(`Overall score: ${p.overallScore != null ? p.overallScore + '%' : 'NOT SCORED'}`)
    if (p.protocols) {
      const protos = Object.entries(p.protocols).map(([k, v]) =>
        `${k}: ${v.status} (${v.envelopes || v.decisions || v.runs || v.witnesses || 0})`
      ).join(', ')
      sections.push(`Protocols: ${protos}`)
    }
    if (p.risks?.length > 0) {
      sections.push(`Active risks: ${p.risks.map(r => `[${r.severity}] ${r.label}`).join('; ')}`)
    }
  }

  // Tab-specific detail
  switch (activeTab) {
    case 'posture':
      // Posture already included above — add trend
      if (data.posture?.trend?.length > 0) {
        sections.push(`Trend (recent scores): ${data.posture.trend.join(', ')}`)
      }
      break

    case 'frameworks':
      if (data.frameworks?.length > 0) {
        sections.push(`\n### Frameworks Visible on Screen`)
        for (const fw of data.frameworks) {
          sections.push(`- **${fw.name}**: ${fw.coverage}% coverage, ${fw.status}, ${fw.controlsMet || 0}/${fw.controlsTotal || 0} controls met, last audit: ${fw.lastAudit || 'never'}`)
          if (fw.sections?.length > 0) {
            for (const sec of fw.sections.slice(0, 5)) {
              sections.push(`  - ${sec.id} ${sec.name}: ${sec.coverage}% (${sec.met}/${sec.controls})`)
            }
          }
        }
      }
      break

    case 'reports':
      if (data.reports?.length > 0) {
        sections.push(`\n### Reports Visible on Screen`)
        for (const r of data.reports.slice(0, 10)) {
          const date = r.generatedAt ? new Date(r.generatedAt).toLocaleDateString() : 'unknown'
          sections.push(`- ${FORMAT_NAMES[r.format] || r.format}: ${r.score}% (${r.status}), ${date}, ${r.traces} traces, ${r.period} days`)
        }
      }
      if (data.scheduledJobs?.length > 0) {
        sections.push(`\nScheduled jobs:`)
        for (const j of data.scheduledJobs) {
          sections.push(`- ${FORMAT_NAMES[j.format] || j.format}: ${j.interval}, next: ${j.nextRun ? new Date(j.nextRun).toLocaleDateString() : '?'}, status: ${j.status}`)
        }
      } else {
        sections.push(`No scheduled jobs configured.`)
      }
      break

    case 'evidence':
      if (data.evidence) {
        const e = data.evidence
        sections.push(`\n### Evidence Visible on Screen`)
        sections.push(`AEE envelopes shown: ${e.envelopes?.length || 0}`)
        sections.push(`VOLT runs shown: ${e.voltRuns?.length || 0}`)
        if (e.wardChain) {
          sections.push(`WARD chain: ${e.wardChain.totalEntries} entries, ${e.wardChain.signedTips} tips, status: ${e.wardChain.chainStatus}`)
          if (e.wardChain.sourceBreakdown) {
            const bd = Object.entries(e.wardChain.sourceBreakdown).map(([k, v]) => `${k}:${v}`).join(', ')
            sections.push(`Source breakdown: ${bd}`)
          }
        }
        if (e.envelopes?.length > 0) {
          sections.push(`Recent envelopes:`)
          for (const env of e.envelopes.slice(0, 5)) {
            sections.push(`- ${env.intent} from ${env.from} → ${env.to} (${env.wardWitnessed ? 'WARD✓' : 'no WARD'})`)
          }
        }
      }
      break

    case 'certification':
      if (data.certification) {
        const c = data.certification
        sections.push(`\n### Certification Visible on Screen`)
        sections.push(`Current tier: ${c.currentTier}`)
        if (c.tiers) {
          for (const tier of c.tiers) {
            const metCount = tier.requirements?.filter(r => r.met).length || 0
            const total = tier.requirements?.length || 0
            sections.push(`- ${tier.name}: ${metCount}/${total} requirements met`)
          }
        }
        if (c.nextRequirements?.length > 0) {
          sections.push(`Next tier requirements:`)
          for (const req of c.nextRequirements) {
            sections.push(`- ${req.label}: ${req.progress}%${req.blocking ? ' (BLOCKING)' : ''}`)
          }
        }
      }
      break

    case 'soa':
      sections.push(`\n### ISO 27001:2022 SoA Builder`)
      sections.push(`User is reviewing the Statement of Applicability. 93 Annex A controls across 4 groups: A.5 Organisational (37), A.6 People (8), A.7 Physical (14), A.8 Technological (34).`)
      sections.push(`A.8 controls auto-populate from AOCL L3/L8/L10 evidence. Other groups require organisational documentation.`)
      sections.push(`Help the user: justify N/A decisions with Art.6(1) references, identify evidence gaps, explain when "Inherited" applies.`)
      break

    case 'classification':
      sections.push(`\n### EU AI Act Risk Classifier`)
      sections.push(`User is classifying an AI system under Regulation (EU) 2024/1689.`)
      sections.push(`7 tiers: Prohibited (Art.5) · High-Risk Annex I (safety components) · High-Risk Annex III (8 use-case categories) · GPAI Systemic (≥10²⁵ FLOPs) · GPAI Standard · Limited Risk (Art.50) · Minimal Risk.`)
      sections.push(`The classifier is FREE tier — a sales funnel tool. Help the user interpret Annex III categories (employment, education, essential services, law enforcement, migration, justice, biometric, critical infra).`)
      break

    case 'dpia':
      sections.push(`\n### GDPR Art.35 DPIA`)
      sections.push(`User is working on a Data Protection Impact Assessment. 6 sections: Description / Necessity / Risks / Measures / Consultation / Outcome.`)
      sections.push(`Lifecycle: Draft → DPO Review → Approved (or Prior Consultation Required if residual risk is high).`)
      sections.push(`5×5 likelihood/severity matrix. Score 1-5 each. Art.35(3) mandatory triggers: systematic evaluation, large-scale special categories, systematic public monitoring.`)
      sections.push(`Help the user: identify when DPIA is required, walk through risk scoring, explain DPO role, reference Art.6(1) legal basis.`)
      break

    case 'auditor':
      sections.push(`\n### Auditor Portal`)
      sections.push(`User is viewing the read-only workspace scoped to an audit engagement.`)
      sections.push(`Features: PBC auto-match (30+ evidence keywords), working paper templates with population counts + sample sizes + VOLT integrity, time-bounded access (30/60/90 days).`)
      sections.push(`Help the user: explain PBC matching logic, describe working paper structure, clarify what an external auditor can and cannot see.`)
      break

    case 'monitor':
      sections.push(`\n### Compliance Monitor`)
      sections.push(`User is viewing real-time compliance posture across 7 frameworks.`)
      sections.push(`Three layers: KPI bar (overall score, open gaps, drift alerts, evidence count), Framework cards, Cross-framework gap heatmap (10 control domains × 7 frameworks).`)
      sections.push(`Drift detection triggers when evidence exceeds threshold age (default 90 days). Posture is server-computed with weighted scoring (compliant=1, partial=0.5, gap=0, not-assessed excluded).`)
      sections.push(`Help the user: interpret heatmap colours (green ≥90%, amber ≥50%, red <50%), prioritise drift alerts, identify cross-framework weak spots.`)
      break

    case 'glossary':
      sections.push(`\n### Compliance Glossary`)
      sections.push(`User is browsing 25 searchable compliance terms across 4 categories: Frameworks, Quox Protocols, Concepts, Audit Terms.`)
      sections.push(`Each term has plain-English definition + "How Quox handles this" section. Help the user: go deeper than the glossary if asked, map terms to product features.`)
      break
  }

  // Investigation context (when user clicked something)
  if (investigation) {
    sections.push(`\n### User Clicked: ${investigation.subject}`)
    sections.push(`The user just clicked on this element. Explain it and provide actionable insight.`)
    if (investigation.data) {
      // Compact JSON of the clicked element (truncated)
      const json = JSON.stringify(investigation.data, null, 0)
      sections.push(`Data: ${json.slice(0, 500)}${json.length > 500 ? '...' : ''}`)
    }
  }

  return sections.join('\n')
}
