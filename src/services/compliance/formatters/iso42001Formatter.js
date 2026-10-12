/**
 * ISO/IEC 42001:2023 — AI Management System (AIMS) Readiness Formatter
 *
 * The first international standard for AI Management Systems. Structured like
 * ISO 27001 (clauses 4-10) plus Annex A controls. Quox can auto-detect
 * evidence for operational (clause 8) and monitoring (clause 9) controls;
 * clauses 4-7 and 10 require organisational documentation.
 *
 * This is a READINESS assessment, not a certification.
 */

export const ISO42001_CONTROLS = {
  // Clause 4 — Context of the organisation
  'Cl.4.1': { id: 'Cl.4.1', clause: '4', name: 'Understanding the organisation and its context', description: 'Determine external and internal issues relevant to the AIMS.', category: 'Context' },
  'Cl.4.2': { id: 'Cl.4.2', clause: '4', name: 'Understanding needs and expectations of interested parties', description: 'Identify interested parties (regulators, users, affected persons) and their requirements.', category: 'Context' },
  'Cl.4.4': { id: 'Cl.4.4', clause: '4', name: 'AI Management System', description: 'Establish, implement, maintain, and continually improve an AIMS including processes and interactions.', category: 'Context' },

  // Clause 5 — Leadership
  'Cl.5.1': { id: 'Cl.5.1', clause: '5', name: 'Leadership and commitment', description: 'Top management demonstrates leadership and commitment to the AIMS.', category: 'Leadership' },
  'Cl.5.2': { id: 'Cl.5.2', clause: '5', name: 'AI Policy', description: 'Establish an AI policy appropriate to the purpose of the organisation.', category: 'Leadership' },
  'Cl.5.3': { id: 'Cl.5.3', clause: '5', name: 'Roles, responsibilities, authorities', description: 'Assign and communicate roles, responsibilities, and authorities for the AIMS.', category: 'Leadership' },

  // Clause 6 — Planning
  'Cl.6.1': { id: 'Cl.6.1', clause: '6', name: 'Actions to address risks and opportunities', description: 'AI risk assessment and risk treatment processes.', category: 'Planning' },
  'Cl.6.2': { id: 'Cl.6.2', clause: '6', name: 'AI objectives and planning to achieve them', description: 'Establish measurable AI objectives at relevant functions and levels.', category: 'Planning' },

  // Clause 7 — Support
  'Cl.7.2': { id: 'Cl.7.2', clause: '7', name: 'Competence', description: 'Determine necessary competence of persons affecting AIMS performance; provide training.', category: 'Support' },
  'Cl.7.3': { id: 'Cl.7.3', clause: '7', name: 'Awareness', description: 'Ensure persons doing work under the organisation\'s control are aware of the AI policy and their contribution.', category: 'Support' },
  'Cl.7.5': { id: 'Cl.7.5', clause: '7', name: 'Documented information', description: 'Control documented information required by the AIMS and the standard.', category: 'Support' },

  // Clause 8 — Operation (STRONGEST QUOX EVIDENCE COVERAGE)
  'Cl.8.1': { id: 'Cl.8.1', clause: '8', name: 'Operational planning and control', description: 'Plan, implement, and control processes to meet AIMS requirements and implement risk treatment. AOCL policy evaluation and VOLT audit trail provide evidence.', category: 'Operation' },
  'Cl.8.2': { id: 'Cl.8.2', clause: '8', name: 'AI risk assessment', description: 'Perform AI risk assessment at planned intervals or when significant changes occur.', category: 'Operation' },
  'Cl.8.3': { id: 'Cl.8.3', clause: '8', name: 'AI risk treatment', description: 'Implement the AI risk treatment plan.', category: 'Operation' },
  'Cl.8.4': { id: 'Cl.8.4', clause: '8', name: 'AI system impact assessment', description: 'Assess potential impact on individuals, groups, and society before and during AI system deployment.', category: 'Operation' },

  // Clause 9 — Performance evaluation (STRONG QUOX COVERAGE)
  'Cl.9.1': { id: 'Cl.9.1', clause: '9', name: 'Monitoring, measurement, analysis, evaluation', description: 'Determine what needs monitoring and measurement, methods, and evaluation of AIMS performance. VOLT hash chain + L8 verification provide continuous evidence.', category: 'Evaluation' },
  'Cl.9.2': { id: 'Cl.9.2', clause: '9', name: 'Internal audit', description: 'Conduct internal audits at planned intervals to determine AIMS conformance.', category: 'Evaluation' },
  'Cl.9.3': { id: 'Cl.9.3', clause: '9', name: 'Management review', description: 'Top management reviews the AIMS at planned intervals.', category: 'Evaluation' },

  // Clause 10 — Improvement
  'Cl.10.1': { id: 'Cl.10.1', clause: '10', name: 'Continual improvement', description: 'Continually improve the suitability, adequacy, and effectiveness of the AIMS.', category: 'Improvement' },
  'Cl.10.2': { id: 'Cl.10.2', clause: '10', name: 'Nonconformity and corrective action', description: 'React to nonconformities and take corrective action.', category: 'Improvement' },
}

export function formatISO42001Report(traceData, period, baseReport) {
  // voltEvidence may arrive on traceData (normal path) or baseReport (legacy path)
  const voltEvidence = traceData?.voltEvidence || baseReport?.voltEvidence
  const layerEvents = traceData?.layerEvents || []
  const envelopes = traceData?.envelopes || []

  const l3Events = layerEvents.filter(e => e.payload?.layer === 'L3')
  const l8Events = layerEvents.filter(e => e.payload?.layer === 'L8')
  const l10Events = layerEvents.filter(e => e.payload?.layer === 'L10')
  // Support both snake_case (canonical from gatherVoltEvidence) and camelCase (legacy)
  const totalRuns = voltEvidence?.total_runs ?? voltEvidence?.totalRuns ?? 0
  const integrityRate = voltEvidence?.integrity_rate ?? voltEvidence?.chainIntegrity ?? 0
  const chainIntact = integrityRate >= 95

  const sections = {
    context: {
      name: 'Clause 4 — Context of the organisation',
      controls: [
        { ...ISO42001_CONTROLS['Cl.4.1'], status: 'requires_action', action_required: 'Document external and internal issues relevant to your AIMS (regulatory landscape, market, technology, workforce, data environment).' },
        { ...ISO42001_CONTROLS['Cl.4.2'], status: 'requires_action', action_required: 'Identify and document interested parties (regulators, customers, affected persons, employees) and their AI-related requirements.' },
        { ...ISO42001_CONTROLS['Cl.4.4'], status: 'requires_action', action_required: 'Establish the AIMS scope and documented processes. Maintain an AI System Lifecycle Record (ASL) for each AI system in scope.' },
      ],
    },
    leadership: {
      name: 'Clause 5 — Leadership',
      controls: [
        { ...ISO42001_CONTROLS['Cl.5.1'], status: 'requires_action', action_required: 'Top management must visibly commit to the AIMS, ensure integration into business processes, and provide resources.' },
        { ...ISO42001_CONTROLS['Cl.5.2'], status: 'requires_action', action_required: 'Establish and publish an AI Policy aligned with the organisation\'s strategic direction.' },
        { ...ISO42001_CONTROLS['Cl.5.3'], status: 'requires_action', action_required: 'Define AI roles (AI Owner, AIMS Manager, Risk Owner) with documented responsibilities.' },
      ],
    },
    planning: {
      name: 'Clause 6 — Planning',
      controls: [
        { ...ISO42001_CONTROLS['Cl.6.1'], status: 'requires_action', action_required: 'Document the AI risk assessment methodology and risk treatment plan. Quox can provide operational evidence once risks are defined.' },
        { ...ISO42001_CONTROLS['Cl.6.2'], status: 'requires_action', action_required: 'Set measurable AI objectives (performance, safety, fairness, robustness) at relevant levels.' },
      ],
    },
    support: {
      name: 'Clause 7 — Support',
      controls: [
        { ...ISO42001_CONTROLS['Cl.7.2'], status: 'requires_action', action_required: 'Document required competencies for AI roles. Provide training and retain training records.' },
        { ...ISO42001_CONTROLS['Cl.7.3'], status: 'requires_action', action_required: 'Ensure workforce awareness of AI policy, their contribution to AIMS effectiveness, and implications of nonconformance.' },
        { ...ISO42001_CONTROLS['Cl.7.5'], status: 'requires_action', action_required: 'Establish document control procedures — version, review, and distribution for all AIMS documentation.' },
      ],
    },
    operation: {
      name: 'Clause 8 — Operation',
      note: 'Clause 8 has the strongest Quox evidence coverage — AOCL policy enforcement and VOLT audit trail provide operational control evidence.',
      controls: [
        {
          ...ISO42001_CONTROLS['Cl.8.1'],
          status: l3Events.length > 0 ? 'partial' : 'not_measured',
          findings: l3Events.length > 0
            ? `AOCL L3 policy evaluation records ${l3Events.length} operational control decisions. VOLT audit trail (${totalRuns} runs) records all AI system invocations.`
            : 'No operational AOCL evidence in period.',
          evidence: { aoclL3: l3Events.length, voltRuns: totalRuns },
        },
        { ...ISO42001_CONTROLS['Cl.8.2'], status: 'requires_action', action_required: 'Perform AI risk assessment at planned intervals. Document methodology and results.' },
        { ...ISO42001_CONTROLS['Cl.8.3'], status: 'requires_action', action_required: 'Implement the risk treatment plan. Link each treatment to observed operational controls (AOCL policies).' },
        { ...ISO42001_CONTROLS['Cl.8.4'], status: 'requires_action', action_required: 'Perform AI System Impact Assessment (AISIA) for each deployed system. Document affected stakeholders, potential harms, and mitigations.' },
      ],
    },
    evaluation: {
      name: 'Clause 9 — Performance evaluation',
      controls: [
        {
          ...ISO42001_CONTROLS['Cl.9.1'],
          status: l8Events.length > 0 && chainIntact ? 'partial' : 'not_measured',
          findings: l8Events.length > 0
            ? `L8 response verification recorded ${l8Events.length} events. VOLT chain integrity: ${integrityRate}%. ${l10Events.length} audit commit events.`
            : 'No monitoring evidence in period.',
          evidence: { aoclL8: l8Events.length, chainIntegrity: integrityRate, auditCommits: l10Events.length },
        },
        { ...ISO42001_CONTROLS['Cl.9.2'], status: 'requires_action', action_required: 'Conduct internal AIMS audits at least annually. Document audit plan, findings, and corrective actions.' },
        { ...ISO42001_CONTROLS['Cl.9.3'], status: 'requires_action', action_required: 'Top management review of AIMS at planned intervals. Document inputs (audit results, performance, feedback) and outputs (decisions, changes).' },
      ],
    },
    improvement: {
      name: 'Clause 10 — Improvement',
      controls: [
        { ...ISO42001_CONTROLS['Cl.10.1'], status: 'requires_action', action_required: 'Document continual improvement activities linked to management review outputs.' },
        { ...ISO42001_CONTROLS['Cl.10.2'], status: 'requires_action', action_required: 'Maintain a nonconformity register with root cause analysis and corrective actions.' },
      ],
    },
  }

  const allControls = Object.values(sections).flatMap(s => s.controls || [])
  const measured = allControls.filter(c => c.status !== 'not_measured')
  const weighted = measured.reduce((sum, c) => sum + (c.status === 'compliant' ? 1 : c.status === 'partial' ? 0.5 : 0), 0)
  const overallScore = measured.length > 0 ? Math.round((weighted / measured.length) * 100) : 0
  const requiresActionCount = allControls.filter(c => c.status === 'requires_action').length
  const evidencedCount = allControls.filter(c => c.status === 'compliant' || c.status === 'partial').length

  let overallStatus = 'material_gaps'
  if (overallScore >= 90 && requiresActionCount === 0) overallStatus = 'substantially_aligned'
  else if (overallScore >= 60) overallStatus = 'partially_evidenced'
  else if (requiresActionCount > 0) overallStatus = 'action_required'

  return {
    ...baseReport,
    format: 'iso42001',
    framework: 'ISO/IEC 42001:2023',
    regulation: 'ISO/IEC 42001:2023 — Artificial Intelligence Management System',
    reportType: 'aims_readiness_assessment',
    disclaimer: 'This is an ISO/IEC 42001 readiness assessment based on system telemetry. It is NOT a certification. ISO/IEC 42001 certification requires an accredited certification body audit covering all 7 management clauses (4-10) and applicable Annex A controls.',
    overallScore,
    overallScoreNote: 'Internal readiness heuristic — not a conformance metric. Clauses 8 and 9 have strongest Quox evidence coverage; clauses 4-7 and 10 require organisational documentation.',
    overallStatus,
    postureStatement: `${evidencedCount} of ${allControls.length} clauses have some system-level evidence. ${requiresActionCount} require organisational action (policies, procedures, training, audits).`,
    sections,
    aiSystemLifecycleRecordGuidance: {
      note: 'ISO 42001 requires documentation of each AI system\'s lifecycle. An AI System Lifecycle Record (ASL) is the ISO 42001 equivalent of GDPR\'s ROPA.',
      recommendedFields: [
        'AI system name and version',
        'Intended purpose and scope',
        'Owner and responsible persons',
        'Training data sources and governance',
        'Performance metrics',
        'Known limitations',
        'Deployment history and changes',
        'Incident and near-miss log',
        'Retirement/decommissioning date',
      ],
      retention: 'Maintain for the operational life of the system plus the period required by applicable regulations.',
    },
  }
}

export default {
  ISO42001_CONTROLS,
  formatISO42001Report,
}
