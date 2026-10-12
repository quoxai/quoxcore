/**
 * NIST AI Risk Management Framework (AI RMF 1.0) Readiness Formatter
 *
 * Four functions: Govern, Map, Measure, Manage.
 * Voluntary framework — adoption is not certifiable, but alignment can be
 * documented. Quox provides strong evidence for Measure (VOLT/L8 metrics) and
 * Manage (HITL/DEFCON responses); Govern and Map require organisational
 * documentation.
 */

export const NIST_AI_RMF_CONTROLS = {
  // GOVERN — Policies, processes, accountability
  'GOVERN-1.1': { id: 'GOVERN-1.1', function: 'Govern', name: 'Policies and procedures', description: 'Legal and regulatory requirements involving AI are understood, managed, documented.', category: 'Govern' },
  'GOVERN-1.2': { id: 'GOVERN-1.2', function: 'Govern', name: 'Accountability structures', description: 'Policies and practices establish clear lines of accountability for AI-related risks.', category: 'Govern' },
  'GOVERN-1.4': { id: 'GOVERN-1.4', function: 'Govern', name: 'Culture of risk management', description: 'Processes of organisational risk management are practised at all levels.', category: 'Govern' },
  'GOVERN-1.6': { id: 'GOVERN-1.6', function: 'Govern', name: 'AI system inventory', description: 'Mechanisms are in place to inventory AI systems and are maintained and resourced.', category: 'Govern' },
  'GOVERN-3.1': { id: 'GOVERN-3.1', function: 'Govern', name: 'Decision-making diversity', description: 'Decision-making related to AI design, development, deployment, evaluation, and use is informed by diverse perspectives.', category: 'Govern' },
  'GOVERN-5.1': { id: 'GOVERN-5.1', function: 'Govern', name: 'Third-party risk', description: 'Third-party AI risks are considered and managed.', category: 'Govern' },

  // MAP — Context and categorization
  'MAP-1.1': { id: 'MAP-1.1', function: 'Map', name: 'Intended purposes and scope', description: 'Intended purposes, potentially beneficial uses, context-specific laws are understood.', category: 'Map' },
  'MAP-1.2': { id: 'MAP-1.2', function: 'Map', name: 'Mission and goals', description: 'Inter-disciplinary collaborators contribute to mapping context.', category: 'Map' },
  'MAP-2.1': { id: 'MAP-2.1', function: 'Map', name: 'AI system categorization', description: 'The specific tasks and methods used to implement the tasks that the AI system will support are defined.', category: 'Map' },
  'MAP-3.1': { id: 'MAP-3.1', function: 'Map', name: 'Expected benefits and costs', description: 'Potential benefits and costs are understood and assessed.', category: 'Map' },
  'MAP-4.1': { id: 'MAP-4.1', function: 'Map', name: 'Approaches and assumptions', description: 'Approaches for mapping AI technology and legal risks are documented.', category: 'Map' },
  'MAP-5.1': { id: 'MAP-5.1', function: 'Map', name: 'Impact assessment', description: 'Likelihood and magnitude of each identified impact (both potentially beneficial and harmful) are determined.', category: 'Map' },

  // MEASURE — Quantitative and qualitative tracking (STRONG QUOX COVERAGE via VOLT)
  'MEASURE-1.1': { id: 'MEASURE-1.1', function: 'Measure', name: 'Metrics identified', description: 'Approaches and metrics for measurement of AI risks are identified.', category: 'Measure' },
  'MEASURE-2.3': { id: 'MEASURE-2.3', function: 'Measure', name: 'Measurement environments', description: 'AI system performance is measured regularly with relevant tools and metrics.', category: 'Measure' },
  'MEASURE-2.4': { id: 'MEASURE-2.4', function: 'Measure', name: 'Ongoing monitoring', description: 'AI system operation and performance are monitored. VOLT hash chain + L8 verification provide continuous evidence.', category: 'Measure' },
  'MEASURE-2.6': { id: 'MEASURE-2.6', function: 'Measure', name: 'Safety metrics', description: 'AI system is evaluated for safety.', category: 'Measure' },
  'MEASURE-3.1': { id: 'MEASURE-3.1', function: 'Measure', name: 'Risk tracking', description: 'Approaches, personnel, and documentation to track mappable risks are in place.', category: 'Measure' },

  // MANAGE — Risk responses and incident handling (STRONG QUOX COVERAGE via HITL/DEFCON)
  'MANAGE-1.2': { id: 'MANAGE-1.2', function: 'Manage', name: 'Response planning', description: 'Treatment plans for identified risks are documented. HITL approval workflows and DEFCON escalations provide response evidence.', category: 'Manage' },
  'MANAGE-2.1': { id: 'MANAGE-2.1', function: 'Manage', name: 'Resource allocation', description: 'Resources required to manage AI risks are allocated commensurate with risk level.', category: 'Manage' },
  'MANAGE-2.4': { id: 'MANAGE-2.4', function: 'Manage', name: 'Incident response', description: 'Mechanisms are in place to respond to identified AI risks and incidents. DEFCON state machine and incident envelopes provide evidence.', category: 'Manage' },
  'MANAGE-3.1': { id: 'MANAGE-3.1', function: 'Manage', name: 'Post-deployment monitoring', description: 'AI risks and benefits from third-party resources are monitored.', category: 'Manage' },
  'MANAGE-4.1': { id: 'MANAGE-4.1', function: 'Manage', name: 'Continuous improvement', description: 'Post-deployment AI system monitoring includes mechanisms to evaluate real-world performance.', category: 'Manage' },
}

export function formatNISTAIRMFReport(traceData, period, baseReport) {
  const voltEvidence = traceData?.voltEvidence || baseReport?.voltEvidence
  const layerEvents = traceData?.layerEvents || []
  const envelopes = traceData?.envelopes || []

  const l3Events = layerEvents.filter(e => e.payload?.layer === 'L3')
  const l8Events = layerEvents.filter(e => e.payload?.layer === 'L8')
  const hitlEvents = envelopes.filter(e => e.intent?.includes('approval') || e.intent?.includes('hitl'))
  const errorEvents = envelopes.filter(e => e.type === 'error')
  // Support both snake_case (canonical) and camelCase (legacy)
  const totalRuns = voltEvidence?.total_runs ?? voltEvidence?.totalRuns ?? 0
  const chainIntegrity = voltEvidence?.integrity_rate ?? voltEvidence?.chainIntegrity ?? 0
  const aiSystemProfile = baseReport?.ai_system_profile || null

  const sections = {
    govern: {
      name: 'Govern — Culture, processes, accountability',
      controls: Object.values(NIST_AI_RMF_CONTROLS)
        .filter(c => c.function === 'Govern')
        .map(c => ({
          ...c,
          status: 'requires_action',
          action_required: `Document organisational approach to ${c.name.toLowerCase()}. This function is inherently organisational and requires written policies and accountability structures.`,
          evidence: [],
        })),
    },
    map: {
      name: 'Map — Context, purpose, and risks',
      controls: Object.values(NIST_AI_RMF_CONTROLS)
        .filter(c => c.function === 'Map')
        .map(c => ({
          ...c,
          status: aiSystemProfile ? 'partial' : 'requires_action',
          findings: aiSystemProfile
            ? `AI system profile provided: ${aiSystemProfile.system_name || 'unnamed'} (${aiSystemProfile.intended_use || 'no use case'}). Risk tier: ${aiSystemProfile.risk_tier || 'unspecified'}.`
            : 'No AI system profile provided. Supply ai_system_profile in report options.',
          action_required: aiSystemProfile ? null : `Provide an AI system profile describing intended use, risk tier, affected parties, and context.`,
        })),
    },
    measure: {
      name: 'Measure — Quantitative and qualitative tracking',
      note: 'Measure has the strongest Quox evidence coverage — VOLT hash chain and L8 verification provide continuous monitoring.',
      controls: [
        { ...NIST_AI_RMF_CONTROLS['MEASURE-1.1'], status: 'requires_action', action_required: 'Document the metrics used to measure AI risks (accuracy, bias, robustness, safety). Link metrics to observed VOLT/L8 signals.' },
        {
          ...NIST_AI_RMF_CONTROLS['MEASURE-2.3'],
          status: totalRuns > 0 ? 'partial' : 'not_measured',
          findings: `VOLT recorded ${totalRuns} AI system invocations in period. L8 verification: ${l8Events.length} events.`,
          evidence: { voltRuns: totalRuns, l8Events: l8Events.length },
        },
        {
          ...NIST_AI_RMF_CONTROLS['MEASURE-2.4'],
          status: chainIntegrity >= 95 && l8Events.length > 0 ? 'partial' : 'not_measured',
          findings: `Continuous monitoring via VOLT hash chain (integrity: ${chainIntegrity}%) and L8 response verification (${l8Events.length} events).`,
          evidence: { chainIntegrity, l8Events: l8Events.length },
        },
        { ...NIST_AI_RMF_CONTROLS['MEASURE-2.6'], status: 'requires_action', action_required: 'Document safety evaluation methodology (red-teaming, adversarial testing, safety benchmarks). Link to L8 verification rejections.' },
        {
          ...NIST_AI_RMF_CONTROLS['MEASURE-3.1'],
          status: l3Events.length > 0 ? 'partial' : 'not_measured',
          findings: `AOCL L3 policy gate records ${l3Events.length} risk-relevant decisions.`,
          evidence: { l3Events: l3Events.length },
        },
      ],
    },
    manage: {
      name: 'Manage — Allocating risk responses',
      note: 'Manage leverages HITL approval events, DEFCON escalations, and incident envelopes for risk response evidence.',
      controls: [
        { ...NIST_AI_RMF_CONTROLS['MANAGE-1.2'], status: 'requires_action', action_required: 'Document risk treatment plans. HITL approval workflows and DEFCON state provide response evidence once plans are defined.' },
        { ...NIST_AI_RMF_CONTROLS['MANAGE-2.1'], status: 'requires_action', action_required: 'Document resource allocation (personnel, tooling, budget) for AI risk management, scaled to system risk tier.' },
        {
          ...NIST_AI_RMF_CONTROLS['MANAGE-2.4'],
          status: (hitlEvents.length > 0 || errorEvents.length > 0) ? 'partial' : 'not_measured',
          findings: `Incident evidence: ${hitlEvents.length} HITL approval events, ${errorEvents.length} error envelopes. DEFCON state machine tracks system-level risk level.`,
          evidence: { hitlEvents: hitlEvents.length, errorEvents: errorEvents.length },
        },
        { ...NIST_AI_RMF_CONTROLS['MANAGE-3.1'], status: 'requires_action', action_required: 'Document third-party AI risks (foundation model providers, libraries). Link to vendor risk assessments.' },
        { ...NIST_AI_RMF_CONTROLS['MANAGE-4.1'], status: 'requires_action', action_required: 'Document continuous improvement processes with clear inputs (monitoring data) and outputs (system changes).' },
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
    format: 'nist-ai-rmf',
    framework: 'NIST AI RMF 1.0',
    regulation: 'NIST AI Risk Management Framework 1.0 (January 2023)',
    reportType: 'nist_ai_rmf_readiness_assessment',
    disclaimer: 'This is a NIST AI RMF readiness assessment. The AI RMF is a voluntary framework — adoption is not certifiable. This report documents alignment with the 4 functions (Govern, Map, Measure, Manage). It does NOT constitute compliance with any legal requirement.',
    overallScore,
    overallScoreNote: 'Internal alignment heuristic — not an official NIST conformance metric. The AI RMF does not define conformance levels.',
    overallStatus,
    postureStatement: `${evidencedCount} of ${allControls.length} controls have some system-level evidence. ${requiresActionCount} require organisational action. Measure and Manage functions have stronger Quox evidence coverage than Govern and Map.`,
    sections,
    aiSystemProfile: aiSystemProfile || {
      note: 'NIST AI RMF recommends maintaining an AI system profile. Provide system_name, intended_use, risk_tier, affected_parties, and context.',
      example: { system_name: 'CustomerSupportBot', intended_use: 'Automated customer query handling', risk_tier: 'limited', affected_parties: ['customers', 'support team'], context: 'B2B SaaS product' },
    },
    crossReferences: {
      note: 'NIST AI RMF outputs can be cross-referenced against other frameworks Quox already evaluates.',
      mappings: [
        { function: 'Govern', mapsTo: 'EU AI Act Art.17 (QMS), ISO 42001 Clause 5 (Leadership)' },
        { function: 'Map', mapsTo: 'EU AI Act Art.9 (Risk Management), ISO 42001 Clause 6 (Planning)' },
        { function: 'Measure', mapsTo: 'SOC 2 CC7 (Monitoring), ISO 42001 Clause 9 (Performance Evaluation)' },
        { function: 'Manage', mapsTo: 'EU AI Act Art.14 (Human Oversight), SOC 2 CC7.4 (Incident Response)' },
      ],
    },
  }
}

export default {
  NIST_AI_RMF_CONTROLS,
  formatNISTAIRMFReport,
}
