/**
 * ISO/IEC 27001:2022 ISMS Readiness Assessment Formatter
 *
 * Produces an ISMS readiness report — NOT a certification or conformity declaration.
 *
 * ISO 27001 certification requires:
 * - Clauses 4–10: ISMS management system requirements (ALL mandatory, non-excludable)
 * - Annex A: Reference controls selected through Statement of Applicability
 *
 * This formatter can partially evidence some Annex A technological controls (A.8)
 * from system telemetry. Clauses 4–10, organisational controls (A.5),
 * people controls (A.6), and physical controls (A.7) require organisational
 * documentation that cannot be inferred from trace data.
 *
 * ISO 27002:2022 provides implementation guidance for Annex A controls.
 * The 2022 edition has 93 controls across 4 categories.
 */

export const ISO27001_CONTROLS = {
  // Clause 4–10 — ISMS Requirements (mandatory, non-excludable)
  'Cl.4': { id: 'Cl.4', name: 'Context of the Organisation', description: 'Understand the organisation, its context, needs and expectations of interested parties, and determine the ISMS scope.', category: 'ISMS Requirements' },
  'Cl.5': { id: 'Cl.5', name: 'Leadership', description: 'Top management shall demonstrate leadership and commitment, establish policy, and assign roles and responsibilities.', category: 'ISMS Requirements' },
  'Cl.6': { id: 'Cl.6', name: 'Planning', description: 'Address risks and opportunities, establish information security objectives, and plan changes.', category: 'ISMS Requirements' },
  'Cl.7': { id: 'Cl.7', name: 'Support', description: 'Determine and provide resources, competence, awareness, communication, and documented information.', category: 'ISMS Requirements' },
  'Cl.8': { id: 'Cl.8', name: 'Operation', description: 'Plan, implement, and control processes to meet requirements and implement risk treatment.', category: 'ISMS Requirements' },
  'Cl.9': { id: 'Cl.9', name: 'Performance Evaluation', description: 'Monitor, measure, analyse, evaluate. Conduct internal audits and management reviews.', category: 'ISMS Requirements' },
  'Cl.10': { id: 'Cl.10', name: 'Improvement', description: 'Address nonconformities, take corrective action, and continually improve the ISMS.', category: 'ISMS Requirements' },

  // Annex A — Organisational Controls (A.5) — require documentation
  'A.5.1': { id: 'A.5.1', name: 'Policies for Information Security', description: 'Policies shall be defined, approved by management, published, communicated, and acknowledged by relevant personnel.', category: 'A.5 Organisational' },
  'A.5.2': { id: 'A.5.2', name: 'Information Security Roles and Responsibilities', description: 'Roles and responsibilities shall be defined and allocated.', category: 'A.5 Organisational' },
  'A.5.7': { id: 'A.5.7', name: 'Threat Intelligence', description: 'Information relating to information security threats shall be collected and analysed.', category: 'A.5 Organisational' },
  'A.5.23': { id: 'A.5.23', name: 'Information Security for Cloud Services', description: 'Processes for acquisition, use, management, and exit from cloud services shall be established.', category: 'A.5 Organisational' },
  'A.5.28': { id: 'A.5.28', name: 'Collection of Evidence', description: 'Procedures for identification, collection, acquisition and preservation of evidence shall be established.', category: 'A.5 Organisational' },

  // Annex A — People Controls (A.6)
  'A.6.1': { id: 'A.6.1', name: 'Screening', description: 'Background verification checks on candidates shall be carried out.', category: 'A.6 People' },
  'A.6.2': { id: 'A.6.2', name: 'Terms and Conditions of Employment', description: 'Employment agreements shall state responsibilities for information security.', category: 'A.6 People' },
  'A.6.3': { id: 'A.6.3', name: 'Information Security Awareness, Education and Training', description: 'Personnel shall receive appropriate awareness, education and training.', category: 'A.6 People' },
  'A.6.5': { id: 'A.6.5', name: 'Responsibilities After Termination', description: 'Information security responsibilities that remain valid after termination shall be defined and enforced.', category: 'A.6 People' },

  // Annex A — Physical Controls (A.7)
  'A.7.1': { id: 'A.7.1', name: 'Physical Security Perimeters', description: 'Security perimeters shall be defined and used to protect areas containing information.', category: 'A.7 Physical' },
  'A.7.2': { id: 'A.7.2', name: 'Physical Entry', description: 'Secure areas shall be protected by appropriate entry controls.', category: 'A.7 Physical' },
  'A.7.4': { id: 'A.7.4', name: 'Physical Security Monitoring', description: 'Premises shall be continuously monitored for unauthorised physical access.', category: 'A.7 Physical' },
  'A.7.10': { id: 'A.7.10', name: 'Storage Media', description: 'Storage media shall be managed through their lifecycle.', category: 'A.7 Physical' },

  // Annex A — Technological Controls (A.8) — partially assessable from telemetry
  'A.8.2': { id: 'A.8.2', name: 'Privileged Access Rights', description: 'Allocation and use of privileged access rights shall be restricted and managed.', category: 'A.8 Technological' },
  'A.8.5': { id: 'A.8.5', name: 'Secure Authentication', description: 'Secure authentication technologies and procedures shall be implemented.', category: 'A.8 Technological' },
  'A.8.9': { id: 'A.8.9', name: 'Configuration Management', description: 'Configurations shall be established, documented, implemented, monitored, and reviewed.', category: 'A.8 Technological' },
  'A.8.15': { id: 'A.8.15', name: 'Logging', description: 'Logs recording activities, exceptions, faults and other relevant events shall be produced, stored, protected and analysed.', category: 'A.8 Technological' },
  'A.8.16': { id: 'A.8.16', name: 'Monitoring Activities', description: 'Networks, systems and applications shall be monitored for anomalous behaviour.', category: 'A.8 Technological' },
  'A.8.24': { id: 'A.8.24', name: 'Use of Cryptography', description: 'Rules for effective use of cryptography shall be defined and implemented.', category: 'A.8 Technological' },
  'A.8.28': { id: 'A.8.28', name: 'Secure Coding', description: 'Secure coding principles shall be applied to software development.', category: 'A.8 Technological' },
}

export function formatISO27001Report(traceData, period, baseReport) {
  const { envelopes, layerEvents, policyDecisions, voltEvidence } = traceData

  const sections = {
    ismsRequirements: formatISMSRequirements(),
    organisationalControls: formatOrganisationalControls(traceData),
    peopleControls: formatPeopleControls(),
    physicalControls: formatPhysicalControls(),
    technologicalControls: formatTechnologicalControls(traceData, voltEvidence),
  }

  // Conservative scoring: requires_action = 0, partial = 0.5, not_measured excluded
  const allControls = Object.values(sections).flatMap(s => s.controls || [])
  const measuredControls = allControls.filter(c => c.status !== 'not_measured')
  const weightedScore = measuredControls.reduce((sum, c) => {
    if (c.status === 'compliant') return sum + 1
    if (c.status === 'partial') return sum + 0.5
    return sum
  }, 0)
  const overallScore = measuredControls.length > 0
    ? Math.round((weightedScore / measuredControls.length) * 100)
    : 0
  const requiresActionCount = allControls.filter(c => c.status === 'requires_action').length
  const notMeasuredCount = allControls.filter(c => c.status === 'not_measured').length
  const evidencedCount = allControls.filter(c => c.status === 'compliant' || c.status === 'partial').length

  let overallStatus = 'material_gaps'
  if (overallScore >= 90 && requiresActionCount === 0 && notMeasuredCount === 0) overallStatus = 'substantially_aligned'
  else if (overallScore >= 60) overallStatus = 'partially_evidenced'
  else if (requiresActionCount > 0) overallStatus = 'action_required'

  return {
    ...baseReport,
    framework: 'ISO/IEC 27001:2022',
    standard: 'Information Security Management Systems — Requirements',
    reportType: 'isms_readiness_assessment',
    disclaimer: 'This is an ISMS readiness assessment based on system telemetry. It is NOT an ISO 27001 conformity or certification statement. ISO 27001 certification requires: (1) Clauses 4–10 management system implementation (all mandatory), (2) risk assessment and treatment, (3) Statement of Applicability covering all 93 Annex A controls, (4) internal audit, (5) management review, and (6) third-party certification audit. Only parts of Annex A technological controls (A.8) can be evidenced from system data.',
    overallScore,
    overallScoreNote: 'Internal maturity heuristic only — not a certification metric. ISO 27001 conformity is assessed through management system audits, not percentage scores.',
    overallStatus,
    postureStatement: `${evidencedCount} of ${allControls.length} items have some system-level evidence. ${requiresActionCount} require organisational action. ${notMeasuredCount} could not be measured programmatically. Clauses 4–10 (ISMS management system) are assessed as action items — these are mandatory and non-excludable.`,
    scope: {
      description: '[CONFIGURE — define the scope of the ISMS: which business processes, organisational units, locations, assets, and technology are covered]',
      inclusions: '[CONFIGURE — list business units, systems, locations, services, and assets within the ISMS boundary]',
      exclusions: '[CONFIGURE — list what is outside the ISMS boundary and why (e.g. business units, locations, systems not in scope)]',
      note: 'Scope exclusions describe what is outside the ISMS boundary. Annex A control exclusions belong in the Statement of Applicability (SoA), not here.',
    },
    sections,
    soaGuidance: generateSOAGuidance(allControls),
  }
}

/**
 * Clauses 4–10 — ISMS Management System Requirements (all mandatory)
 */
function formatISMSRequirements() {
  return {
    name: 'ISMS Requirements (Clauses 4–10)',
    note: 'Clauses 4–10 are mandatory management system requirements. They cannot be excluded. They require documented processes, management commitment, risk methodology, internal audits, and continuous improvement. None can be assessed from system telemetry.',
    controls: [
      { ...ISO27001_CONTROLS['Cl.4'], status: 'requires_action', findings: 'Determine external/internal issues, interested parties, ISMS scope. Document the scope.', action_required: 'Document organisation context, interested parties, and ISMS scope boundary.', evidence: [] },
      { ...ISO27001_CONTROLS['Cl.5'], status: 'requires_action', findings: 'Top management must demonstrate commitment, establish information security policy, and assign ISMS roles.', action_required: 'Obtain management commitment. Publish an information security policy. Assign ISMS roles (e.g. CISO, risk owner).', evidence: [] },
      { ...ISO27001_CONTROLS['Cl.6'], status: 'requires_action', findings: 'Plan risk assessment methodology, conduct risk assessment, determine risk treatment, set security objectives.', action_required: 'Define risk assessment methodology. Conduct risk assessment. Produce risk treatment plan. Set measurable security objectives.', evidence: [] },
      { ...ISO27001_CONTROLS['Cl.7'], status: 'requires_action', findings: 'Provide resources, ensure competence, raise awareness, manage communications, control documented information.', action_required: 'Allocate ISMS resources. Define competence requirements. Implement awareness programme. Establish document control.', evidence: [] },
      { ...ISO27001_CONTROLS['Cl.8'], status: 'requires_action', findings: 'Implement risk treatment plan, manage operational processes, conduct risk assessments at planned intervals.', action_required: 'Implement risk treatment. Define operational procedures. Schedule periodic risk assessments.', evidence: [] },
      { ...ISO27001_CONTROLS['Cl.9'], status: 'requires_action', findings: 'Monitor, measure, analyse, and evaluate ISMS effectiveness. Conduct internal audits. Perform management reviews.', action_required: 'Establish monitoring metrics. Schedule internal audits. Conduct management reviews at planned intervals. Document results.', evidence: [] },
      { ...ISO27001_CONTROLS['Cl.10'], status: 'requires_action', findings: 'Address nonconformities, take corrective action, continually improve the ISMS.', action_required: 'Implement nonconformity and corrective action procedures. Track improvements. Review ISMS effectiveness.', evidence: [] },
    ]
  }
}

/**
 * Annex A.5 — Organisational Controls
 */
function formatOrganisationalControls(traceData) {
  const { envelopes, layerEvents, policyDecisions } = traceData
  const auditEvents = layerEvents.filter(e => e.payload?.layer === 'L10' || e.intent?.includes('audit'))

  return {
    name: 'Organisational Controls (Annex A.5)',
    note: 'Organisational controls require documented policies, defined roles, and management processes. System telemetry provides supporting evidence but does not prove policy governance.',
    controls: [
      {
        ...ISO27001_CONTROLS['A.5.1'], status: 'requires_action',
        findings: 'A.5.1 requires policies to be defined, approved by management, published, communicated to relevant personnel, and acknowledged. AOCL L3 Policy Gate provides runtime enforcement, but this is not the same as documented, approved, and communicated policies.',
        action_required: 'Define, approve, publish, and communicate information security policies. Obtain acknowledgement from personnel. Review policies at planned intervals.',
        evidence: [{ type: 'supporting', description: 'L3 Policy Gate provides runtime policy enforcement mechanism' }]
      },
      {
        ...ISO27001_CONTROLS['A.5.2'], status: 'requires_action',
        findings: 'Observed agent/user identifiers in AEE envelopes do not constitute defined and allocated roles and responsibilities. A.5.2 requires formal role definitions with documented responsibilities.',
        action_required: 'Define information security roles and responsibilities. Document role assignments. Ensure separation of duties where appropriate.',
        evidence: [{ type: 'supporting', description: 'AEE envelopes track actor identities — useful for role verification' }]
      },
      {
        ...ISO27001_CONTROLS['A.5.7'],
        status: policyDecisions.length > 0 ? 'partial' : 'requires_action',
        findings: policyDecisions.length > 0
          ? `${policyDecisions.filter(e => e.payload?.status === 'reject').length} policy rejections and ${envelopes.filter(e => e.type === 'error').length} error events provide threat intelligence inputs. A.5.7 also requires structured threat analysis, intelligence sharing, and response to identified threats.`
          : 'No policy rejection or threat intelligence events in period.',
        action_required: 'Establish threat intelligence collection and analysis process. Subscribe to relevant threat feeds. Document response procedures.',
        evidence: [{ type: 'threat_indicators', rejections: policyDecisions.filter(e => e.payload?.status === 'reject').length, errorEvents: envelopes.filter(e => e.type === 'error').length }]
      },
      {
        ...ISO27001_CONTROLS['A.5.23'], status: 'requires_action',
        findings: 'Cloud service security requires documented processes for acquisition, use, management, and exit — including AI/LLM provider assessments. L7 delegate layer events do not constitute cloud governance.',
        action_required: 'Document cloud service management procedures. Assess AI/LLM provider security. Define exit strategy for each cloud service.',
        evidence: []
      },
      {
        ...ISO27001_CONTROLS['A.5.28'],
        status: auditEvents.length > 0 || envelopes.length > 0 ? 'partial' : 'requires_action',
        findings: `AEE protocol provides evidence collection framework (${envelopes.length} events, ${auditEvents.length} audit layer events). VOLT hash chains provide tamper-evident evidence preservation. A.5.28 also requires documented evidence handling procedures.`,
        action_required: 'Document evidence collection, handling, and preservation procedures. Define chain of custody requirements.',
        evidence: [{ type: 'evidence_capability', events: envelopes.length, audit_events: auditEvents.length }]
      },
    ]
  }
}

/**
 * Annex A.6 — People Controls (entirely organisational)
 */
function formatPeopleControls() {
  return {
    name: 'People Controls (Annex A.6)',
    note: 'People controls are HR and personnel management requirements. Not assessable from system telemetry.',
    controls: [
      { ...ISO27001_CONTROLS['A.6.1'], status: 'requires_action', findings: 'Background screening must be conducted in accordance with laws, regulations, ethics, and proportionate to business requirements.', action_required: 'Implement pre-employment screening procedures. Document screening criteria.', evidence: [] },
      { ...ISO27001_CONTROLS['A.6.2'], status: 'requires_action', findings: 'Employment contracts must state information security responsibilities during and after employment.', action_required: 'Include information security clauses in employment agreements. Define NDA/confidentiality requirements.', evidence: [] },
      { ...ISO27001_CONTROLS['A.6.3'], status: 'requires_action', findings: 'All personnel must receive information security awareness, education, and training appropriate to their role.', action_required: 'Implement a security awareness and training programme. Track completion. Review and update content.', evidence: [] },
      { ...ISO27001_CONTROLS['A.6.5'], status: 'requires_action', findings: 'Post-termination responsibilities must be defined, communicated, and enforced (e.g. NDA continuity, access revocation).', action_required: 'Document post-termination information security obligations. Implement access revocation on termination.', evidence: [] },
    ]
  }
}

/**
 * Annex A.7 — Physical Controls (entirely organisational)
 */
function formatPhysicalControls() {
  return {
    name: 'Physical Controls (Annex A.7)',
    note: 'Physical controls protect facilities and equipment. Not assessable from application telemetry. For cloud/container deployments, document how the hosting provider addresses these controls.',
    controls: [
      { ...ISO27001_CONTROLS['A.7.1'], status: 'requires_action', findings: 'Security perimeters must protect areas containing information and information processing facilities.', action_required: 'Define and document physical security perimeters. For cloud deployments, verify provider physical security certifications.', evidence: [] },
      { ...ISO27001_CONTROLS['A.7.2'], status: 'requires_action', findings: 'Secure areas must be protected by appropriate entry controls to ensure only authorised personnel access them.', action_required: 'Implement physical entry controls. Maintain visitor logs. For cloud: document provider access controls.', evidence: [] },
      { ...ISO27001_CONTROLS['A.7.4'], status: 'requires_action', findings: 'Premises shall be continuously monitored for unauthorised physical access.', action_required: 'Implement physical monitoring (CCTV, sensors). For cloud: verify provider monitoring.', evidence: [] },
      { ...ISO27001_CONTROLS['A.7.10'], status: 'requires_action', findings: 'Storage media must be managed through their lifecycle including disposal.', action_required: 'Document media management and secure disposal procedures.', evidence: [] },
    ]
  }
}

/**
 * Annex A.8 — Technological Controls (partially assessable from telemetry)
 */
function formatTechnologicalControls(traceData, voltEvidence) {
  const { envelopes, layerEvents, policyDecisions } = traceData
  const l3Events = layerEvents.filter(e => e.payload?.layer === 'L3')
  const l8Events = layerEvents.filter(e => e.payload?.layer === 'L8')
  const uniqueUsers = [...new Set(envelopes.map(e => e.from).filter(Boolean))]

  return {
    name: 'Technological Controls (Annex A.8)',
    note: 'Some technological controls can be partially evidenced from system telemetry. Telemetry is supporting evidence — not proof of policy, procedures, or governance.',
    controls: [
      {
        ...ISO27001_CONTROLS['A.8.2'],
        status: l3Events.length > 0 ? 'partial' : 'requires_action',
        findings: l3Events.length > 0
          ? `AOCL L3 Policy Gate provides access control enforcement (${l3Events.length} evaluations). However, A.8.2 requires documented privileged access management including: allocation, review, and revocation procedures.`
          : 'No L3 policy gate evidence in period.',
        action_required: 'Document privileged access management procedures. Implement periodic access reviews. Define access revocation processes.',
        evidence: [{ type: 'l3_enforcement', events: l3Events.length }]
      },
      {
        ...ISO27001_CONTROLS['A.8.5'],
        status: uniqueUsers.length > 0 ? 'partial' : 'not_measured',
        findings: uniqueUsers.length > 0
          ? `${uniqueUsers.length} unique identifiers observed in AEE envelopes. A.8.5 requires implemented authentication technologies and procedures — observed identifiers are not proof of secure authentication implementation (identity proofing, credential management, MFA).`
          : 'No user identifiers observed.',
        action_required: 'Document authentication procedures. Implement MFA where appropriate. Define credential management lifecycle.',
        evidence: [{ type: 'observed_identifiers', count: uniqueUsers.length, note: 'Observed — not proof of authentication procedures' }]
      },
      {
        ...ISO27001_CONTROLS['A.8.9'], status: 'requires_action',
        findings: 'AOCL layer configuration provides a processing framework, but A.8.9 requires documented configuration baselines, change management, and security hardening — not just the existence of configurable layers.',
        action_required: 'Document configuration baselines. Implement configuration change management. Conduct security hardening reviews.',
        evidence: []
      },
      {
        ...ISO27001_CONTROLS['A.8.15'],
        status: envelopes.length > 0 ? 'partial' : 'not_measured',
        findings: envelopes.length > 0
          ? `AEE protocol logging active: ${envelopes.length} events in period. ${layerEvents.length} AOCL layer events. A.8.15 also requires: log protection, log analysis, and log retention policies.`
          : 'No logging events in period.',
        action_required: 'Document log management policy (retention, protection, analysis). Implement regular log review procedures.',
        evidence: [{ type: 'logging', total: envelopes.length, layers: layerEvents.length }]
      },
      ...(voltEvidence ? [{
        id: 'VOLT-INTEGRITY',
        name: 'VOLT Cryptographic Log Integrity (Additional Internal Control)',
        description: 'Hash-chained event logs with Evidence Bundle verification — additional to Annex A, supporting A.8.15 log integrity.',
        category: 'A.8 Technological (Additional)',
        status: voltEvidence.integrity_rate >= 95 ? 'partial' : 'not_measured',
        findings: `${voltEvidence.valid_count}/${voltEvidence.verified_sample} VOLT evidence bundles verified (${voltEvidence.integrity_rate}% integrity rate). This is an additional internal control providing tamper-evident log integrity — it supports A.8.15 but is not an official Annex A control.`,
        evidence: [{ type: 'volt_integrity', integrity_rate: voltEvidence.integrity_rate, runs: voltEvidence.total_runs }]
      }] : []),
      {
        ...ISO27001_CONTROLS['A.8.16'],
        status: layerEvents.length > 0 ? 'partial' : 'not_measured',
        findings: layerEvents.length > 0
          ? `AOCL layer events provide processing monitoring. A.8.16 also requires anomalous behaviour detection, alerting, and response procedures.`
          : 'No monitoring evidence in period.',
        action_required: 'Define anomaly detection criteria. Implement alerting. Document monitoring response procedures.',
        evidence: [{ type: 'monitoring', layer_events: layerEvents.length }]
      },
      {
        ...ISO27001_CONTROLS['A.8.24'], status: 'not_measured',
        findings: 'Server-side AEE data encrypted at field level (AES-256-GCM). TLS at infrastructure level. A.8.24 requires documented cryptography rules including: key management, algorithm selection, and usage policies.',
        action_required: 'Document cryptography policy. Define key management procedures. Document algorithm selection rationale.',
        evidence: [{ type: 'encryption', atRest: 'AES-256-GCM (server-side)', inTransit: 'TLS (infrastructure)' }]
      },
      {
        ...ISO27001_CONTROLS['A.8.28'], status: 'requires_action',
        findings: 'L8 response verification is output checking, not secure coding practice. A.8.28 requires: secure coding standards, code review procedures, security testing, and dependency management.',
        action_required: 'Adopt secure coding standards. Implement code review procedures. Conduct security testing (SAST/DAST). Manage dependencies.',
        evidence: [{ type: 'supporting', description: 'L8 verification provides output safety checking — supporting but not sufficient for A.8.28' }]
      },
    ]
  }
}

/**
 * SoA Guidance — not an auto-generated SoA
 */
function generateSOAGuidance(allControls) {
  return {
    note: 'A Statement of Applicability (SoA) must document ALL necessary controls (from Annex A and any additional), state WHY each is necessary, whether it is implemented, and justify any exclusions. This guidance identifies controls assessed in this report — the organisation must complete the full SoA covering all 93 Annex A controls.',
    assessedControls: allControls.filter(c => !c.id.startsWith('Cl.')).map(c => ({
      id: c.id,
      name: c.name,
      status: c.status,
      category: c.category,
    })),
    clauseNote: 'Clauses 4–10 are mandatory ISMS requirements, not Annex A controls. They are assessed separately above and are not part of the SoA.',
    action_required: 'Produce a complete SoA covering all 93 Annex A controls. For each: state necessity justification, implementation status, and exclusion rationale where applicable. The SoA is a mandatory ISO 27001 certification deliverable.',
    totalAnnexAControls: 93,
    assessedInThisReport: allControls.filter(c => !c.id.startsWith('Cl.')).length,
    coverageNote: `This report assesses ${allControls.filter(c => !c.id.startsWith('Cl.')).length} of 93 Annex A controls. The remaining controls must be assessed through organisational review.`,
  }
}

export default {
  ISO27001_CONTROLS,
  formatISO27001Report
}
