/**
 * GDPR Readiness Assessment Formatter
 *
 * Produces a GDPR readiness report — NOT a compliance declaration.
 * Separates system-evidenced controls (what we can prove from trace data)
 * from organisational controls (what the customer must configure/document).
 *
 * Articles covered: 5 (Principles), 13/14 (Transparency), 25 (Design),
 * 30 (Records), 32 (Security), 33/34 (Breach), 35 (DPIA)
 */

export const GDPR_ARTICLES = {
  'Art.5(1)(a)': { id: 'Art.5(1)(a)', name: 'Lawfulness, Fairness, Transparency', description: 'Personal data shall be processed lawfully, fairly and in a transparent manner.', category: 'Principles' },
  'Art.5(1)(b)': { id: 'Art.5(1)(b)', name: 'Purpose Limitation', description: 'Collected for specified, explicit and legitimate purposes.', category: 'Principles' },
  'Art.5(1)(c)': { id: 'Art.5(1)(c)', name: 'Data Minimisation', description: 'Adequate, relevant and limited to what is necessary.', category: 'Principles' },
  'Art.5(1)(d)': { id: 'Art.5(1)(d)', name: 'Accuracy', description: 'Accurate and, where necessary, kept up to date.', category: 'Principles' },
  'Art.5(1)(e)': { id: 'Art.5(1)(e)', name: 'Storage Limitation', description: 'Kept for no longer than necessary.', category: 'Principles' },
  'Art.5(1)(f)': { id: 'Art.5(1)(f)', name: 'Integrity and Confidentiality', description: 'Appropriate security of personal data.', category: 'Principles' },
  'Art.5(2)': { id: 'Art.5(2)', name: 'Accountability', description: 'Demonstrate compliance with principles.', category: 'Principles' },
  'Art.13': { id: 'Art.13', name: 'Information to Data Subject (Direct Collection)', description: 'Provide identity, purposes, lawful basis, recipients, transfers, retention, rights.', category: 'Transparency' },
  'Art.14': { id: 'Art.14', name: 'Information to Data Subject (Indirect Collection)', description: 'Same as Art.13 plus source of data and categories of personal data.', category: 'Transparency' },
  'Art.25(1)': { id: 'Art.25(1)', name: 'Data Protection by Design', description: 'Implement appropriate technical and organisational measures.', category: 'Design' },
  'Art.25(2)': { id: 'Art.25(2)', name: 'Data Protection by Default', description: 'Only necessary personal data processed by default.', category: 'Design' },
  'Art.30(1)': { id: 'Art.30(1)', name: 'Records of Processing (ROPA)', description: 'Maintain records of processing activities.', category: 'Records' },
  'Art.32(1)': { id: 'Art.32(1)', name: 'Security of Processing', description: 'Appropriate technical and organisational security measures.', category: 'Security' },
  'Art.32(1)(a)': { id: 'Art.32(1)(a)', name: 'Pseudonymisation and Encryption', description: 'The pseudonymisation and encryption of personal data.', category: 'Security' },
  'Art.32(1)(b)': { id: 'Art.32(1)(b)', name: 'CIA and Resilience', description: 'Ongoing confidentiality, integrity, availability and resilience.', category: 'Security' },
  'Art.32(1)(d)': { id: 'Art.32(1)(d)', name: 'Testing and Evaluation', description: 'Regularly test and evaluate security effectiveness.', category: 'Security' },
  'Art.33': { id: 'Art.33', name: 'Breach Notification to Authority', description: 'Notify supervisory authority within 72 hours.', category: 'Breach' },
  'Art.34': { id: 'Art.34', name: 'Breach Notification to Data Subjects', description: 'Notify data subjects when breach poses high risk.', category: 'Breach' },
  'Art.35': { id: 'Art.35', name: 'Data Protection Impact Assessment', description: 'Carry out DPIA where processing likely results in high risk.', category: 'DPIA' },
  'Art.15': { id: 'Art.15', name: 'Right of Access', description: 'Data subject has the right to obtain confirmation and access to personal data being processed.', category: 'DataSubjectRights' },
  'Art.16': { id: 'Art.16', name: 'Right to Rectification', description: 'Data subject has the right to have inaccurate personal data rectified.', category: 'DataSubjectRights' },
  'Art.17': { id: 'Art.17', name: 'Right to Erasure (Right to be Forgotten)', description: 'Data subject has the right to erasure of personal data without undue delay (within 1 month, extendable by 2 months if complex).', category: 'DataSubjectRights' },
  'Art.18': { id: 'Art.18', name: 'Right to Restriction of Processing', description: 'Data subject has the right to restrict processing in specified circumstances.', category: 'DataSubjectRights' },
  'Art.20': { id: 'Art.20', name: 'Right to Data Portability', description: 'Data subject has the right to receive personal data in a structured, commonly used, machine-readable format.', category: 'DataSubjectRights' },
  'Art.21': { id: 'Art.21', name: 'Right to Object', description: 'Data subject has the right to object to processing based on legitimate interests or direct marketing.', category: 'DataSubjectRights' },
  'Art.28': { id: 'Art.28', name: 'Processor', description: 'Controller shall only use processors providing sufficient guarantees. Processing by processor shall be governed by a Data Processing Agreement (DPA).', category: 'Processors' },
}

/**
 * Format trace data as GDPR readiness assessment
 */
export function formatGDPRReport(traceData, period, baseReport) {
  const { envelopes, layerEvents, policyDecisions, voltEvidence } = traceData

  const sections = {
    principles: formatPrinciples(traceData, voltEvidence),
    transparency: formatTransparency(),
    designAndDefault: formatDesignAndDefault(traceData),
    recordsOfProcessing: formatRecordsOfProcessing(traceData, period),
    securityMeasures: formatSecurityMeasures(traceData),
    breachManagement: formatBreachManagement(traceData),
    dpia: formatDPIA(traceData),
    dataSubjectRights: formatDataSubjectRights(),
  }

  // Conservative scoring: partial=0.5, not_measured excluded, requires_action excluded
  // requires_action counts as 0 (gap), not excluded from denominator
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
  const partialCount = allControls.filter(c => c.status === 'partial').length
  const notMeasuredCount = allControls.filter(c => c.status === 'not_measured').length
  const requiresActionCount = allControls.filter(c => c.status === 'requires_action').length

  // Never use legal compliance language — this is a readiness assessment
  let overallStatus = 'material_gaps'
  if (overallScore >= 90 && requiresActionCount === 0 && notMeasuredCount === 0) overallStatus = 'substantially_aligned'
  else if (overallScore >= 60) overallStatus = 'partially_evidenced'
  else if (requiresActionCount > 0) overallStatus = 'action_required'

  return {
    ...baseReport,
    framework: 'GDPR',
    regulation: 'Regulation (EU) 2016/679',
    reportType: 'readiness_assessment',
    disclaimer: 'This is a technical readiness assessment based on system telemetry. It is NOT a legal compliance declaration. GDPR compliance requires organisational measures, legal basis documentation, privacy notices, and DPO oversight that cannot be verified from system data alone.',
    overallScore,
    overallStatus,
    postureStatement: generatePostureStatement(allControls, requiresActionCount, notMeasuredCount),
    sections,
    ropaGuidance: generateROPAGuidance(traceData, period),
    legalBasisGuidance: generateLegalBasisGuidance(),
    internationalTransferAssessment: assessInternationalTransfers(traceData),
    processorAssessment: assessProcessors(traceData),
  }
}

function generatePostureStatement(controls, requiresAction, notMeasured) {
  const evidenced = controls.filter(c => c.status === 'compliant' || c.status === 'partial').length
  const total = controls.length
  if (requiresAction > 0) {
    return `${requiresAction} of ${total} controls require organisational action before GDPR alignment can be assessed. ${evidenced} controls have some system-level evidence. ${notMeasured} could not be measured programmatically. This report identifies gaps — it does not declare compliance.`
  }
  return `${evidenced} of ${total} controls have some system-level evidence. ${notMeasured} controls could not be measured programmatically. Organisational review required before any compliance claim.`
}

/**
 * Article 5 — Principles. Honest about what system data proves vs what it doesn't.
 */
function formatPrinciples(traceData, voltEvidence) {
  const { envelopes, layerEvents } = traceData
  const purposeIntents = [...new Set(envelopes.map(e => e.intent).filter(Boolean))]
  const l3Events = layerEvents.filter(e => e.payload?.layer === 'L3')
  const l8Events = layerEvents.filter(e => e.payload?.layer === 'L8')

  return {
    name: 'Data Processing Principles (Article 5)',
    controls: [
      {
        ...GDPR_ARTICLES['Art.5(1)(a)'],
        // Transparency to DATA SUBJECTS is an organisational requirement, not a system feature
        status: 'requires_action',
        findings: 'GDPR transparency requires informing data subjects about processing purposes, lawful basis, recipients, retention, and their rights (Articles 13/14). System-level observability (AOCL pipeline) supports internal transparency but does not satisfy the data subject notification requirement.',
        action_required: 'Publish a privacy notice covering all processing activities. Ensure data subjects are informed at the point of data collection.',
        evidence: [{ type: 'system_capability', description: 'AOCL provides internal processing observability', note: 'This is NOT the same as data subject transparency' }]
      },
      {
        ...GDPR_ARTICLES['Art.5(1)(b)'],
        status: purposeIntents.length > 0 ? 'partial' : 'not_measured',
        findings: purposeIntents.length > 0
          ? `${purposeIntents.length} distinct processing purposes identified from system intents. Purpose limitation requires that these purposes are explicitly documented and that data is not further processed for incompatible purposes.`
          : 'No processing intents recorded in period.',
        action_required: 'Document each processing purpose explicitly. Map purposes to lawful bases. Ensure no function creep.',
        evidence: [{ type: 'purpose_tracking', uniqueIntents: purposeIntents.length }]
      },
      {
        ...GDPR_ARTICLES['Art.5(1)(c)'],
        status: 'requires_action',
        findings: 'Data minimisation requires a documented assessment that only necessary data is collected. L0 input normalisation provides a technical mechanism but does not prove minimisation without a data mapping exercise.',
        action_required: 'Conduct a data mapping exercise documenting what personal data is collected, why, and confirm each field is necessary.',
        evidence: [{ type: 'architecture', description: 'L0 normalisation layer provides technical minimisation mechanism' }]
      },
      {
        ...GDPR_ARTICLES['Art.5(1)(d)'],
        status: voltEvidence ? 'partial' : 'not_measured',
        findings: voltEvidence
          ? `VOLT integrity verification provides cryptographic proof of data accuracy within the system (${voltEvidence.integrity_rate}% integrity rate over ${voltEvidence.total_runs} runs). However, accuracy also requires processes to correct inaccurate data and respond to data subject rectification requests.`
          : 'No VOLT evidence available. Accuracy principle requires both technical integrity and organisational processes for correction.',
        action_required: 'Implement a data subject rectification process (Art.16). Establish procedures for keeping personal data up to date.',
        evidence: voltEvidence ? [{ type: 'volt_integrity', integrity_rate: voltEvidence.integrity_rate, runs: voltEvidence.total_runs }] : []
      },
      {
        ...GDPR_ARTICLES['Art.5(1)(e)'],
        status: 'requires_action',
        findings: 'Storage limitation requires defined retention periods per processing purpose and a mechanism to delete/anonymise data when no longer needed. No retention policy enforcement was detected in the system.',
        action_required: 'Define retention periods for each processing activity. Implement automated data deletion/anonymisation. Document in ROPA.',
        evidence: []
      },
      {
        ...GDPR_ARTICLES['Art.5(1)(f)'],
        status: l3Events.length > 0 && l8Events.length > 0 ? 'partial' : 'not_measured',
        findings: l3Events.length > 0
          ? `Security measures evidenced: ${l3Events.length} L3 Policy Gate evaluations, ${l8Events.length} L8 response verifications. Server-side AEE data encrypted at field level (AES-256-GCM). Full assessment requires Art.32 security review.`
          : 'Insufficient security event evidence in period.',
        evidence: [{ type: 'security_layers', l3_events: l3Events.length, l8_events: l8Events.length }]
      },
      {
        ...GDPR_ARTICLES['Art.5(2)'],
        status: envelopes.length > 0 ? 'partial' : 'not_measured',
        findings: envelopes.length > 0
          ? `Accountability supported by ${envelopes.length} audit records in period. AOCL layer events and VOLT hash chains provide technical accountability. Full accountability also requires documented policies, staff training, DPO appointment, and DPIA processes.`
          : 'No audit records in period.',
        action_required: 'Appoint a DPO (if required). Document data protection policies. Conduct staff training. Maintain this report as part of accountability evidence.',
        evidence: [{ type: 'audit_records', count: envelopes.length, layer_events: layerEvents.length }]
      },
    ]
  }
}

/**
 * Articles 13/14 — Transparency (entirely organisational)
 */
function formatTransparency() {
  return {
    name: 'Transparency to Data Subjects (Articles 13/14)',
    controls: [
      {
        ...GDPR_ARTICLES['Art.13'],
        status: 'requires_action',
        findings: 'Art.13 requires that when personal data is collected directly from the data subject, they are informed of: controller identity, DPO contact, purposes, lawful basis, recipients, international transfers, retention period, their rights (access, rectification, erasure, restriction, portability, objection), right to withdraw consent, right to lodge a complaint. This is a documentation and communication requirement — not verifiable from system telemetry.',
        action_required: 'Publish a privacy notice meeting Art.13 requirements. Ensure it is provided at the point of data collection.',
        evidence: []
      },
      {
        ...GDPR_ARTICLES['Art.14'],
        status: 'requires_action',
        findings: 'Art.14 applies when personal data is obtained from a source other than the data subject. Same information requirements as Art.13 plus: categories of personal data and the source. Must be provided within one month or at first communication.',
        action_required: 'If the system processes personal data obtained indirectly (e.g. from third-party integrations), ensure Art.14 notices are in place.',
        evidence: []
      },
    ]
  }
}

/**
 * Article 25 — Design and Default
 */
function formatDesignAndDefault(traceData) {
  const { layerEvents } = traceData
  const l0Events = layerEvents.filter(e => e.payload?.layer === 'L0')

  return {
    name: 'Data Protection by Design and Default (Article 25)',
    controls: [
      {
        ...GDPR_ARTICLES['Art.25(1)'],
        status: 'partial',
        findings: 'AOCL 11-layer processing pipeline provides a privacy-by-design architecture with dedicated layers for policy enforcement (L3), verification (L8), and audit (L10). This provides the technical framework; organisational measures (privacy policies, staff procedures, DPO oversight) are also required.',
        evidence: [{ type: 'architecture', description: '11-layer AOCL pipeline with L3 policy gate and L8 response verification' }]
      },
      {
        ...GDPR_ARTICLES['Art.25(2)'],
        status: l0Events.length > 0 ? 'partial' : 'not_measured',
        findings: l0Events.length > 0
          ? `L0 Ingress layer normalises input (${l0Events.length} events). Default settings should ensure only necessary personal data is processed. Review default agent configurations and data collection scope.`
          : 'No L0 normalisation events in period.',
        action_required: 'Review all agent configurations to ensure default settings minimise personal data processing.',
        evidence: [{ type: 'l0_normalisation', events: l0Events.length }]
      },
    ]
  }
}

/**
 * Article 30 — ROPA guidance (not auto-generated scaffolding)
 */
function formatRecordsOfProcessing(traceData, period) {
  const { envelopes } = traceData

  // Identify processing activity categories from intents
  const activityTypes = {}
  for (const e of envelopes) {
    const category = e.intent?.split('.').slice(0, 2).join('.') || 'unknown'
    activityTypes[category] = (activityTypes[category] || 0) + 1
  }

  return {
    name: 'Records of Processing Activities (Article 30)',
    controls: [
      {
        ...GDPR_ARTICLES['Art.30(1)'],
        status: 'requires_action',
        findings: `System telemetry identifies ${Object.keys(activityTypes).length} processing activity categories in this period. However, a compliant ROPA requires: controller name and contact, DPO contact, processing purposes, categories of data subjects, categories of personal data, categories of recipients, international transfers with safeguards, retention periods, and security measures — per processing activity. This data must be provided by the organisation, not inferred from system logs.`,
        action_required: 'Complete the ROPA template below with real organisational data. Do not rely on auto-generated placeholders.',
        evidence: [{ type: 'activity_categories', categories: activityTypes }]
      },
    ]
  }
}

/**
 * Article 32 — Security measures
 */
function formatSecurityMeasures(traceData) {
  const { layerEvents } = traceData
  const l8Events = layerEvents.filter(e => e.payload?.layer === 'L8')

  return {
    name: 'Security of Processing (Article 32)',
    controls: [
      {
        ...GDPR_ARTICLES['Art.32(1)'],
        status: 'partial',
        findings: 'Technical measures include: AOCL L3 policy gate (access control), L8 response verification (integrity), AES-256-GCM field encryption (confidentiality), TLS in transit. Organisational measures (security policies, staff training, incident response procedures, access reviews) must be documented separately.',
        evidence: [{ type: 'technical_measures', measures: ['L3 Policy Gate', 'L8 Verification', 'AES-256-GCM encryption', 'TLS'] }]
      },
      {
        ...GDPR_ARTICLES['Art.32(1)(a)'],
        status: 'not_measured',
        findings: 'Server-side AEE data encrypted at field level (AES-256-GCM). TLS configured at infrastructure level. Pseudonymisation of personal data in agent processing is not implemented. Encryption coverage not measured programmatically.',
        action_required: 'Assess whether pseudonymisation is appropriate for your processing activities. Document encryption scope.',
        evidence: [{ type: 'encryption', atRest: 'AES-256-GCM field encryption (server-side)', inTransit: 'HTTPS/TLS (infrastructure)' }]
      },
      {
        ...GDPR_ARTICLES['Art.32(1)(b)'],
        status: 'not_measured',
        findings: 'Confidentiality: L3 policy gate + RBAC. Integrity: L8 verification + VOLT hash chains. Availability: infrastructure-dependent (not measured by this system). Resilience: not assessed.',
        evidence: [{ type: 'cia', confidentiality: 'L3 + RBAC', integrity: 'L8 + VOLT', availability: 'not measured', resilience: 'not assessed' }]
      },
      {
        ...GDPR_ARTICLES['Art.32(1)(d)'],
        status: l8Events.length > 0 ? 'partial' : 'not_measured',
        findings: l8Events.length > 0
          ? `${l8Events.length} automated verification tests performed via L8 layer in period. Regular testing should also include penetration testing, vulnerability scanning, and policy reviews.`
          : 'No L8 verification events in period.',
        action_required: 'Establish a regular security testing programme beyond automated L8 verification.',
        evidence: l8Events.slice(0, 5).map(e => ({ id: e.id, ts: e.ts, result: e.payload?.status }))
      },
    ]
  }
}

/**
 * Articles 33/34 — Breach notification
 */
function formatBreachManagement(traceData) {
  const { envelopes } = traceData
  const securityEvents = envelopes.filter(e => {
    const intent = e.intent || ''
    const msg = String(e.payload?.message || e.payload?.error || '').toLowerCase()
    return intent.includes('policy') || intent.includes('reject') || intent.includes('block')
      || msg.includes('injection') || msg.includes('credential') || msg.includes('unauthorized')
      || msg.includes('denied') || msg.includes('violation')
  })

  return {
    name: 'Breach Notification (Articles 33/34)',
    controls: [
      {
        ...GDPR_ARTICLES['Art.33'],
        status: 'requires_action',
        findings: `Security event detection active: ${securityEvents.length} security-relevant events in period. However, Art.33 compliance requires: (1) a documented breach assessment process to determine if a breach involves personal data and poses risk, (2) notification to the supervisory authority within 72 hours, (3) documented details including nature of breach, categories of data subjects, likely consequences, and remedial measures. Event monitoring alone is breach DETECTION, not breach NOTIFICATION compliance.`,
        action_required: 'Document a personal data breach procedure covering: detection → assessment → classification → notification → documentation → remediation → lessons learned. Designate a breach response team. Test the procedure.',
        evidence: [{ type: 'detection_capability', security_events: securityEvents.length, note: 'Detection is step 1 of 7 in breach response' }]
      },
      {
        ...GDPR_ARTICLES['Art.34'],
        status: 'requires_action',
        findings: 'Art.34 requires notification to affected data subjects when a breach poses HIGH risk to their rights and freedoms. This requires: risk assessment capability, data subject communication templates, and a process to determine when notification is required.',
        action_required: 'Prepare data subject notification templates. Define criteria for when data subject notification is triggered.',
        evidence: []
      },
    ]
  }
}

/**
 * Article 35 — DPIA
 */
function formatDPIA(traceData) {
  return {
    name: 'Data Protection Impact Assessment (Article 35)',
    controls: [
      {
        ...GDPR_ARTICLES['Art.35'],
        status: 'requires_action',
        findings: 'AI agent processing is likely to result in high risk to individuals (automated decision-making, profiling, large-scale processing). A DPIA is required under Art.35. A DPIA must systematically describe the processing, assess necessity and proportionality, assess risks to individuals, and identify measures to mitigate those risks. This cannot be auto-generated from system telemetry.',
        action_required: 'Conduct a full DPIA following ICO/supervisory authority guidance. Document: processing description, necessity assessment, risk assessment, mitigation measures, DPO consultation, and review schedule.',
        evidence: [{ type: 'dpia_indicator', note: 'AI agent processing triggers DPIA requirement under Art.35(3)(a) — automated decision-making' }]
      },
    ]
  }
}

/**
 * ROPA guidance template — what the customer needs to fill in
 */
function generateROPAGuidance(traceData, period) {
  const { envelopes } = traceData
  const activityTypes = {}
  for (const e of envelopes) {
    const cat = e.intent?.split('.').slice(0, 2).join('.') || 'unknown'
    activityTypes[cat] = (activityTypes[cat] || 0) + 1
  }

  return {
    note: 'This is a ROPA TEMPLATE based on detected processing activities. All fields marked [CONFIGURE] must be completed with real organisational data before this constitutes a compliant Article 30 record.',
    controllerName: '[CONFIGURE — your organisation name]',
    controllerContact: '[CONFIGURE — controller contact details]',
    dpoContact: '[CONFIGURE — DPO name and contact, or state why DPO not required]',
    detectedActivities: Object.entries(activityTypes).map(([category, count]) => ({
      category,
      count,
      purposes: '[CONFIGURE — document the specific purposes for this processing]',
      legalBasis: '[CONFIGURE — identify lawful basis per Art.6(1). If legitimate interests, complete an LIA.]',
      dataSubjectCategories: '[CONFIGURE — e.g. employees, customers, website visitors]',
      personalDataCategories: '[CONFIGURE — e.g. names, email addresses, usage data]',
      recipients: '[CONFIGURE — categories of recipients, not named system actors]',
      internationalTransfers: '[CONFIGURE — identify any transfers outside UK/EEA. Document safeguards (SCCs, adequacy decisions).]',
      retentionPeriod: '[CONFIGURE — specific retention period per purpose, e.g. "2 years from last interaction"]',
      securityMeasures: '[CONFIGURE — describe technical and organisational measures for this activity]',
    })),
    generatedAt: new Date().toISOString(),
    period,
  }
}

/**
 * Legal basis guidance — not a determination
 */
function generateLegalBasisGuidance() {
  return {
    note: 'Legal basis must be determined per processing purpose by the data controller with legal advice. The system cannot determine your lawful basis.',
    availableBases: [
      { basis: 'Consent — Art.6(1)(a)', guidance: 'Requires freely given, specific, informed, unambiguous consent. Must be as easy to withdraw as to give. Record consent and withdrawal.' },
      { basis: 'Contract — Art.6(1)(b)', guidance: 'Processing necessary for performance of a contract with the data subject. Cannot be stretched to cover processing that is merely useful.' },
      { basis: 'Legal obligation — Art.6(1)(c)', guidance: 'Processing necessary to comply with a legal obligation on the controller.' },
      { basis: 'Vital interests — Art.6(1)(d)', guidance: 'Processing necessary to protect the vital interests of the data subject or another person. Used rarely — typically emergency/life-threatening situations.' },
      { basis: 'Public interest or official authority — Art.6(1)(e)', guidance: 'Processing necessary for the performance of a task carried out in the public interest or exercise of official authority vested in the controller.' },
      { basis: 'Legitimate interests — Art.6(1)(f)', guidance: 'Requires a three-part test: (1) identify the legitimate interest, (2) show processing is necessary for that interest, (3) balance against data subject rights. Document the LIA. Not available to public authorities for core tasks.' },
    ],
    action_required: 'For each processing activity in your ROPA, identify and document the specific lawful basis. If relying on legitimate interests, complete and retain a Legitimate Interests Assessment (LIA).',
  }
}

/**
 * FMT-V2-3: Data Subject Rights section (Art.15-21)
 * These are inherently organisational — they require procedures for receiving, validating, and responding to requests.
 */
function formatDataSubjectRights() {
  return {
    name: 'Data Subject Rights (Articles 15-21)',
    note: 'Data subject rights require organisational procedures to receive, validate, and respond to requests. The Quox platform records processing events but does not itself handle DSARs — you must implement request-handling workflows in your business processes.',
    controls: [
      {
        ...GDPR_ARTICLES['Art.15'],
        status: 'requires_action',
        findings: 'Data subjects have the right to confirm whether their data is processed and obtain a copy. Requires a DSAR process with identity verification.',
        recommendations: [
          'Publish a Subject Access Request (SAR) submission channel (email, form, or portal)',
          'Implement identity verification procedures',
          'Log SAR receipts and responses (timing is critical — 1 month deadline)',
          'Train staff on what data must be disclosed',
        ],
      },
      {
        ...GDPR_ARTICLES['Art.16'],
        status: 'requires_action',
        findings: 'Data subjects can request correction of inaccurate data. Controller must rectify without undue delay.',
        recommendations: [
          'Provide a channel for rectification requests',
          'Document correction decisions (what was changed, when, by whom)',
          'Notify recipients of corrected data if feasible (Art.19)',
        ],
      },
      {
        ...GDPR_ARTICLES['Art.17'],
        status: 'requires_action',
        findings: 'Right to erasure ("right to be forgotten") applies in specified circumstances. Response must be without undue delay (within 1 month, extendable by 2 months if complex).',
        recommendations: [
          'Implement data erasure procedures across all systems (including backups and replicas)',
          'Document erasure decisions and their legal basis (including refusals under Art.17(3) exemptions)',
          'Consider overall retention schedule — erasure may be automatic when retention expires',
          'Ensure AI model training data handling accounts for erasure requests',
        ],
      },
      {
        ...GDPR_ARTICLES['Art.18'],
        status: 'requires_action',
        findings: 'Data subjects can request processing be restricted in specified circumstances (e.g. accuracy contested, objection pending).',
        recommendations: [
          'Implement technical means to flag and restrict specific records',
          'Document restriction decisions and the specific Art.18(1) circumstance that applies',
        ],
      },
      {
        ...GDPR_ARTICLES['Art.20'],
        status: 'requires_action',
        findings: 'Data portability applies when processing is based on consent or contract AND is automated. Data must be provided in structured, commonly used, machine-readable format.',
        recommendations: [
          'Define export formats (typically JSON or CSV) for each processing activity',
          'Document which processing activities are portability-eligible (consent/contract + automated)',
          'Implement direct controller-to-controller transmission where technically feasible',
        ],
      },
      {
        ...GDPR_ARTICLES['Art.21'],
        status: 'requires_action',
        findings: 'Data subjects have an unconditional right to object to direct marketing. For legitimate interests processing, the right applies unless compelling legitimate grounds override.',
        recommendations: [
          'Provide an unsubscribe mechanism for any direct marketing',
          'Log objection receipts and implementation',
          'Evaluate legitimate interests balancing test when objection is raised',
        ],
      },
    ],
  }
}

/**
 * FMT-V2-3: Art.28 Processor Assessment
 * AI providers (Anthropic, OpenAI, Google) are data processors under GDPR when they process personal data.
 * The controller must verify they provide sufficient guarantees and sign a Data Processing Agreement (DPA).
 */
function assessProcessors(traceData) {
  const { envelopes } = traceData
  const detectedProviders = new Set()
  for (const e of envelopes) {
    const path = e.payload?.path || ''
    if (path.includes('openai') || e.intent?.includes('openai')) detectedProviders.add('OpenAI')
    if (path.includes('anthropic') || path === 'messages_api' || path === 'mcp') detectedProviders.add('Anthropic')
    if (path.includes('gemini') || path.includes('google')) detectedProviders.add('Google')
    if (path.includes('perplexity')) detectedProviders.add('Perplexity')
  }

  const providers = Array.from(detectedProviders).map(p => ({
    provider: p,
    role: 'Data Processor (Art.28)',
    dpaRequired: true,
    dpaStatus: '[CONFIGURE — verify signed DPA exists with this provider]',
    subProcessors: '[CONFIGURE — processor must disclose and authorise sub-processors]',
    art28Requirements: [
      'Process only on documented instructions from the controller',
      'Ensure personnel confidentiality',
      'Implement Art.32 security measures',
      'Only engage sub-processors with prior authorisation',
      'Assist controller with DSAR responses and breach notifications',
      'Delete or return data at end of service',
      'Make available all information necessary to demonstrate compliance',
    ],
  }))

  return {
    note: 'Under GDPR Art.28, every data processor (including AI providers that process personal data) must have a Data Processing Agreement (DPA) with sufficient guarantees. Controller remains liable for processor compliance.',
    detectedProcessors: providers,
    action_required: providers.length > 0
      ? `${providers.length} AI provider(s) detected. Verify each has a signed DPA meeting Art.28 requirements. Document sub-processor chains.`
      : 'No external AI providers detected in this period. If any are added, ensure Art.28 DPA is in place before processing begins.',
    dpaChecklist: [
      'Subject matter and duration of processing',
      'Nature and purpose of processing',
      'Type of personal data',
      'Categories of data subjects',
      'Obligations and rights of the controller',
      'Processor\'s Art.28(3)(a)-(h) obligations',
    ],
  }
}

/**
 * International transfer assessment — check configured LLM providers
 */
function assessInternationalTransfers(traceData) {
  const { envelopes } = traceData

  // Detect external API usage from envelope patterns
  const externalProviders = new Set()
  for (const e of envelopes) {
    const path = e.payload?.path || ''
    if (path.includes('openai') || e.intent?.includes('openai')) externalProviders.add('OpenAI (US)')
    if (path.includes('anthropic') || path === 'messages_api' || path === 'mcp') externalProviders.add('Anthropic (US)')
    if (path.includes('gemini') || path.includes('google')) externalProviders.add('Google/Gemini (US)')
    if (path.includes('perplexity')) externalProviders.add('Perplexity (US)')
  }

  const hasTransfers = externalProviders.size > 0

  return {
    hasInternationalTransfers: hasTransfers,
    note: hasTransfers
      ? `WARNING: ${externalProviders.size} external AI provider(s) detected in processing data. If these providers process personal data outside the UK/EEA, international transfer safeguards are required (Chapter V GDPR).`
      : 'No external AI providers detected in this period. If local inference is used exclusively, international transfer requirements may not apply. Verify with your DPO.',
    detectedProviders: Array.from(externalProviders).map(p => ({
      provider: p,
      transferMechanism: '[CONFIGURE — e.g. Standard Contractual Clauses, adequacy decision, binding corporate rules]',
      dataResidencyConfigured: false,
      action_required: `Verify ${p} data processing agreement covers GDPR requirements. Confirm transfer mechanism. Check if data residency options are available and configured.`,
    })),
    action_required: hasTransfers
      ? 'Complete a Transfer Impact Assessment (TIA) for each provider. Implement appropriate safeguards under Chapter V.'
      : null,
  }
}

export default {
  GDPR_ARTICLES,
  formatGDPRReport
}
