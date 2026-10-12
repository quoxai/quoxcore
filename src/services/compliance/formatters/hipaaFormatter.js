/**
 * HIPAA Security Rule Readiness Assessment Formatter
 *
 * Produces a HIPAA Security Rule readiness report — NOT a compliance declaration.
 * The Security Rule requires administrative, physical, and technical safeguards
 * plus organisational, policy, and documentation requirements.
 *
 * This formatter can only assess parts of §164.312 (Technical Safeguards) from
 * system telemetry. Administrative safeguards (§164.308), physical safeguards
 * (§164.310), and organisational requirements (§164.314) require organisational
 * documentation that cannot be inferred from trace data.
 *
 * HHS/OCR guidance: risk analysis and risk management are foundational.
 * "Addressable" does not mean "optional" — entities must assess, document, and
 * implement or document why an alternative is appropriate.
 */

export const HIPAA_REQUIREMENTS = {
  // §164.308 — Administrative Safeguards (organisational — not measurable from telemetry)
  '164.308(a)(1)': { id: '164.308(a)(1)', name: 'Security Management Process', standard: 'Implement policies and procedures to prevent, detect, contain, and correct security violations.', category: 'Administrative Safeguards' },
  '164.308(a)(1)(ii)(A)': { id: '164.308(a)(1)(ii)(A)', name: 'Risk Analysis (Required)', standard: 'Conduct an accurate and thorough assessment of potential risks and vulnerabilities to ePHI.', category: 'Administrative Safeguards' },
  '164.308(a)(1)(ii)(B)': { id: '164.308(a)(1)(ii)(B)', name: 'Risk Management (Required)', standard: 'Implement security measures to reduce risks and vulnerabilities to a reasonable and appropriate level.', category: 'Administrative Safeguards' },
  '164.308(a)(3)': { id: '164.308(a)(3)', name: 'Workforce Security', standard: 'Implement policies and procedures to ensure workforce members have appropriate access to ePHI.', category: 'Administrative Safeguards' },
  '164.308(a)(5)': { id: '164.308(a)(5)', name: 'Security Awareness and Training', standard: 'Implement a security awareness and training program for all workforce members.', category: 'Administrative Safeguards' },
  '164.308(a)(6)': { id: '164.308(a)(6)', name: 'Security Incident Procedures', standard: 'Implement policies and procedures to address security incidents.', category: 'Administrative Safeguards' },
  '164.308(a)(7)': { id: '164.308(a)(7)', name: 'Contingency Plan', standard: 'Establish policies and procedures for responding to an emergency or other occurrence that damages systems containing ePHI.', category: 'Administrative Safeguards' },

  // §164.312 — Technical Safeguards (partially assessable from telemetry)
  '164.312(a)(1)': { id: '164.312(a)(1)', name: 'Access Control', standard: 'Implement technical policies and procedures for electronic information systems that maintain ePHI.', category: 'Technical Safeguards' },
  '164.312(a)(2)(i)': { id: '164.312(a)(2)(i)', name: 'Unique User Identification (Required)', standard: 'Assign a unique name and/or number for identifying and tracking user identity.', category: 'Technical Safeguards' },
  '164.312(a)(2)(ii)': { id: '164.312(a)(2)(ii)', name: 'Emergency Access Procedure (Required)', standard: 'Establish procedures for obtaining necessary ePHI during an emergency.', category: 'Technical Safeguards' },
  '164.312(a)(2)(iii)': { id: '164.312(a)(2)(iii)', name: 'Automatic Logoff (Addressable)', standard: 'Implement electronic procedures that terminate a session after a predetermined time of inactivity.', category: 'Technical Safeguards' },
  '164.312(a)(2)(iv)': { id: '164.312(a)(2)(iv)', name: 'Encryption and Decryption (Addressable)', standard: 'Implement a mechanism to encrypt and decrypt ePHI.', category: 'Technical Safeguards' },
  '164.312(b)': { id: '164.312(b)', name: 'Audit Controls (Required)', standard: 'Implement hardware, software, and/or procedural mechanisms that record and examine activity in systems containing or using ePHI.', category: 'Technical Safeguards' },
  '164.312(c)(1)': { id: '164.312(c)(1)', name: 'Integrity (Required)', standard: 'Implement policies and procedures to protect ePHI from improper alteration or destruction.', category: 'Technical Safeguards' },
  '164.312(c)(2)': { id: '164.312(c)(2)', name: 'Mechanism to Authenticate ePHI (Addressable)', standard: 'Implement electronic mechanisms to corroborate that ePHI has not been altered or destroyed.', category: 'Technical Safeguards' },
  '164.312(d)': { id: '164.312(d)', name: 'Person or Entity Authentication (Required)', standard: 'Implement procedures to verify that a person or entity seeking access to ePHI is the one claimed.', category: 'Technical Safeguards' },
  '164.312(e)(1)': { id: '164.312(e)(1)', name: 'Transmission Security (Required)', standard: 'Implement technical security measures to guard against unauthorized access to ePHI being transmitted over a network.', category: 'Technical Safeguards' },
  '164.312(e)(2)(i)': { id: '164.312(e)(2)(i)', name: 'Integrity Controls (Addressable)', standard: 'Implement security measures to ensure electronically transmitted ePHI is not improperly modified without detection.', category: 'Technical Safeguards' },
  '164.312(e)(2)(ii)': { id: '164.312(e)(2)(ii)', name: 'Encryption (Addressable)', standard: 'Implement a mechanism to encrypt ePHI whenever deemed appropriate.', category: 'Technical Safeguards' },

  // §164.314 — Organisational Requirements
  '164.314(a)': { id: '164.314(a)', name: 'Business Associate Contracts', standard: 'Contract must require business associates to implement safeguards for ePHI.', category: 'Organisational Requirements' },

  // §164.316 — Policies and Procedures / Documentation
  '164.316(a)': { id: '164.316(a)', name: 'Policies and Procedures', standard: 'Implement reasonable and appropriate policies and procedures to comply with the standards and specifications.', category: 'Documentation' },
  '164.316(b)(1)': { id: '164.316(b)(1)', name: 'Documentation (Required)', standard: 'Maintain policies and procedures in written form. Retain for 6 years from date of creation or last effective date.', category: 'Documentation' },
}

export function formatHIPAAReport(traceData, period, baseReport) {
  const { envelopes, layerEvents, policyDecisions, voltEvidence } = traceData

  const sections = {
    scopeAndApplicability: formatScope(),
    administrativeSafeguards: formatAdministrativeSafeguards(),
    physicalSafeguards: formatPhysicalSafeguards(),
    technicalSafeguards: formatTechnicalSafeguards(traceData, voltEvidence),
    organisationalRequirements: formatOrganisationalRequirements(),
    documentation: formatDocumentation(),
  }

  // Conservative scoring: requires_action counts as 0 (gap), not excluded from denominator
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

  // Never use legal compliance language
  let overallStatus = 'material_gaps'
  if (overallScore >= 90 && requiresActionCount === 0 && notMeasuredCount === 0) overallStatus = 'substantially_aligned'
  else if (overallScore >= 60) overallStatus = 'partially_evidenced'
  else if (requiresActionCount > 0) overallStatus = 'action_required'

  return {
    ...baseReport,
    framework: 'HIPAA Security Rule',
    regulation: '45 CFR Part 164 Subpart C',
    reportType: 'security_rule_readiness_assessment',
    disclaimer: 'This is a technical readiness assessment based on system telemetry. It is NOT a HIPAA compliance declaration. The Security Rule requires administrative safeguards (§164.308), physical safeguards (§164.310), technical safeguards (§164.312), organisational requirements (§164.314), and documentation (§164.316). Only parts of §164.312 can be assessed from system data. Risk analysis, written policies, workforce training, contingency plans, and business associate agreements must be documented separately.',
    overallScore,
    overallScoreNote: 'Internal maturity heuristic only — not an audit metric. Based on technical safeguard evidence; administrative, physical, and organisational controls are scored as gaps. OCR does not use percentage-based scoring.',
    overallStatus,
    postureStatement: `${evidencedCount} of ${allControls.length} controls have some system-level evidence. ${requiresActionCount} require organisational action. ${notMeasuredCount} could not be measured programmatically. This assessment covers all Security Rule safeguard categories; only technical safeguards (§164.312) have system-level evidence.`,
    sections,
    riskAssessmentGuidance: generateRiskAssessmentGuidance(sections),
    baaAssessment: generateBAAAssessment(traceData),
    addressableGuidance: generateAddressableGuidance(),
  }
}

/**
 * FMT-V2-4: BAA (Business Associate Agreement) assessment for AI providers
 */
function generateBAAAssessment(traceData) {
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
    possibleRole: 'Potential Business Associate (if ePHI is transmitted)',
    baaRequired: true,
    baaStatus: '[CONFIGURE — verify signed BAA if ePHI is processed]',
    notes: 'If your use of this service involves transmitting ePHI, a BAA is required under §164.314. Even without ePHI, review the vendor\'s HIPAA-ready offerings and data handling policies.',
  }))

  return {
    note: 'Under HIPAA §164.314, covered entities and business associates must have Business Associate Agreements (BAAs) with any entity that creates, receives, maintains, or transmits ePHI on their behalf. This includes AI/LLM service providers IF ePHI is sent to their APIs.',
    detectedProviders: providers,
    baaRequiredElements: [
      'Establish permitted uses and disclosures of ePHI',
      'Require appropriate safeguards to prevent unauthorised use or disclosure',
      'Require reporting of any use/disclosure not permitted by the agreement',
      'Require that subcontractors agree to the same restrictions',
      'Require availability of ePHI for individual access (§164.524)',
      'Require amendments and accountings of disclosures',
      'Return or destroy all ePHI at termination (if feasible)',
      'Authorise termination if material breach occurs',
    ],
    action_required: providers.length > 0
      ? `${providers.length} AI provider(s) detected. Confirm whether ePHI is transmitted to each. If yes, ensure a signed BAA is in place before continued use. Many major providers offer HIPAA BAAs on specific service tiers — verify with each vendor.`
      : 'No external AI providers detected in this period. If ePHI-related processing is added, evaluate BAA requirements before beginning processing.',
  }
}

/**
 * FMT-V2-4: Addressable specification guidance
 * "Addressable" is the most misunderstood HIPAA concept — it does NOT mean optional.
 */
function generateAddressableGuidance() {
  return {
    clarification: 'Addressable does NOT mean optional. For each addressable specification, the covered entity must: (1) assess whether the implementation specification is a reasonable and appropriate safeguard, (2) if so, implement it; (3) if not, document why and implement an equivalent alternative measure OR document why no safeguard is reasonable.',
    examples: [
      { spec: '§164.312(a)(2)(iii) Automatic Logoff (Addressable)', typicalDecision: 'Implement — session timeout is reasonable and appropriate in most environments' },
      { spec: '§164.312(a)(2)(iv) Encryption and Decryption (Addressable)', typicalDecision: 'Implement — encryption is expected baseline; non-implementation must be documented with strong justification' },
      { spec: '§164.312(e)(2)(ii) Encryption for Transmission (Addressable)', typicalDecision: 'Implement — TLS is standard for network transmission of ePHI' },
    ],
    documentationRequirement: 'Document the assessment for every addressable specification. Include: the decision (implement / alternative / no safeguard), the reasoning, the date, and the decision-maker. Review annually.',
  }
}

/**
 * Scope — the most important first question
 */
function formatScope() {
  return {
    name: 'Scope and Applicability',
    controls: [
      {
        id: 'SCOPE',
        name: 'ePHI Scope Determination',
        standard: 'Identify whether this system creates, receives, maintains, or transmits electronic Protected Health Information (ePHI).',
        category: 'Scope',
        status: 'requires_action',
        findings: 'HIPAA Security Rule obligations attach to systems that create, receive, maintain, or transmit ePHI. This assessment cannot determine from system telemetry whether the data processed constitutes ePHI. If this system does not handle ePHI, the Security Rule does not apply.',
        action_required: 'Determine whether this system is in scope for HIPAA. If it processes ePHI: identify the covered entity or business associate, document the scope, and proceed with this assessment. If not: document the exclusion rationale.',
        evidence: []
      },
    ]
  }
}

/**
 * §164.308 — Administrative Safeguards (entirely organisational)
 */
function formatAdministrativeSafeguards() {
  return {
    name: 'Administrative Safeguards (§164.308)',
    note: 'Administrative safeguards are organisational requirements. They cannot be verified from system telemetry. Each item below requires documented policies, procedures, and evidence of implementation.',
    controls: [
      {
        ...HIPAA_REQUIREMENTS['164.308(a)(1)(ii)(A)'],
        status: 'requires_action',
        findings: 'HHS/OCR states that risk analysis is foundational to Security Rule compliance. A thorough risk analysis must identify all ePHI, assess threats and vulnerabilities, determine likelihood and impact, and assign risk levels. This cannot be auto-generated from system data.',
        action_required: 'Conduct a comprehensive risk analysis covering all systems that create, receive, maintain, or transmit ePHI. Document the methodology, findings, and risk ratings. Review and update annually or after significant changes.',
        evidence: []
      },
      {
        ...HIPAA_REQUIREMENTS['164.308(a)(1)(ii)(B)'],
        status: 'requires_action',
        findings: 'Risk management requires implementing security measures sufficient to reduce risks and vulnerabilities to a reasonable and appropriate level, based on the risk analysis.',
        action_required: 'Document a risk management plan that addresses each risk identified in the risk analysis. Implement security measures and track remediation.',
        evidence: []
      },
      {
        ...HIPAA_REQUIREMENTS['164.308(a)(5)'],
        status: 'requires_action',
        findings: 'All workforce members with access to ePHI must receive security awareness training. Training must cover: password management, malicious software protection, login monitoring, and security reminders.',
        action_required: 'Implement a security awareness and training programme. Document training delivery and attendance. Provide periodic security reminders.',
        evidence: []
      },
      {
        ...HIPAA_REQUIREMENTS['164.308(a)(6)'],
        status: 'requires_action',
        findings: 'Security incident procedures must cover: identification, response, mitigation, and documentation of security incidents. System telemetry provides detection capability but not incident response procedures.',
        action_required: 'Document incident response procedures covering: detection → classification → containment → eradication → recovery → lessons learned. Designate an incident response team. Test the procedure.',
        evidence: []
      },
      {
        ...HIPAA_REQUIREMENTS['164.308(a)(7)'],
        status: 'requires_action',
        findings: 'Contingency plan must include: data backup plan, disaster recovery plan, emergency mode operation plan, testing and revision procedures, and applications and data criticality analysis.',
        action_required: 'Document a contingency plan. Test it. Review and update periodically.',
        evidence: []
      },
    ]
  }
}

/**
 * §164.310 — Physical Safeguards (entirely organisational)
 */
function formatPhysicalSafeguards() {
  return {
    name: 'Physical Safeguards (§164.310)',
    note: 'Physical safeguards protect physical access to systems containing ePHI. These are facility and device-level controls that cannot be assessed from application telemetry.',
    controls: [
      {
        id: '164.310(a)(1)',
        name: 'Facility Access Controls (Required)',
        standard: 'Implement policies and procedures to limit physical access to electronic information systems and the facilities in which they are housed.',
        category: 'Physical Safeguards',
        status: 'requires_action',
        findings: 'Facility access controls include: contingency operations procedures, facility security plan, access control and validation procedures, and maintenance records. These are physical/facility-level requirements.',
        action_required: 'Document facility access policies. Implement physical access controls (locks, badges, visitor logs). Define contingency procedures for facility access during emergencies.',
        evidence: []
      },
      {
        id: '164.310(b)',
        name: 'Workstation Use (Required)',
        standard: 'Implement policies and procedures that specify the proper functions to be performed, the manner in which those functions are to be performed, and the physical attributes of the surroundings of workstations that access ePHI.',
        category: 'Physical Safeguards',
        status: 'requires_action',
        findings: 'Workstation use policies must define acceptable use, physical surroundings requirements, and access restrictions for workstations that can access ePHI.',
        action_required: 'Document workstation use policies. Define physical security requirements for workstations accessing ePHI.',
        evidence: []
      },
      {
        id: '164.310(c)',
        name: 'Workstation Security (Required)',
        standard: 'Implement physical safeguards for all workstations that access ePHI, to restrict access to authorized users.',
        category: 'Physical Safeguards',
        status: 'requires_action',
        findings: 'Physical safeguards for workstations may include: screen locks, cable locks, secure locations, privacy screens.',
        action_required: 'Implement and document physical workstation security measures.',
        evidence: []
      },
      {
        id: '164.310(d)(1)',
        name: 'Device and Media Controls (Required)',
        standard: 'Implement policies and procedures that govern the receipt and removal of hardware and electronic media that contain ePHI.',
        category: 'Physical Safeguards',
        status: 'requires_action',
        findings: 'Device and media controls must cover: disposal, media re-use, accountability (hardware/media tracking), and data backup and storage. For cloud/container deployments, document how virtual resources are managed.',
        action_required: 'Document device and media control procedures. Include disposal, re-use, and tracking policies. Address cloud/container resource lifecycle.',
        evidence: []
      },
    ]
  }
}

/**
 * §164.312 — Technical Safeguards (partially assessable)
 */
function formatTechnicalSafeguards(traceData, voltEvidence) {
  const { envelopes, layerEvents, policyDecisions } = traceData

  const uniqueUsers = [...new Set(envelopes.map(e => e.from).filter(Boolean))]
  const humanSessions = envelopes.filter(e => e.from?.startsWith('human.'))
  const uniqueSessions = [...new Set(humanSessions.map(e => e.corr))]
  const l3Events = layerEvents.filter(e => e.payload?.layer === 'L3')
  const l8Events = layerEvents.filter(e => e.payload?.layer === 'L8')
  const l10Events = layerEvents.filter(e => e.payload?.layer === 'L10' || e.intent?.includes('audit'))

  return {
    name: 'Technical Safeguards (§164.312)',
    note: 'These controls can be partially assessed from system telemetry. "Addressable" specifications require documented assessment — if not implemented, the entity must document why and what alternative was adopted.',
    controls: [
      // Access Control
      {
        ...HIPAA_REQUIREMENTS['164.312(a)(1)'],
        status: l3Events.length > 0 ? 'partial' : 'not_measured',
        findings: l3Events.length > 0
          ? `AOCL L3 Policy Gate provides technical access control framework. ${l3Events.length} policy evaluations in period. Full compliance requires documented access control policies aligned to ePHI access needs.`
          : 'No L3 policy gate events recorded. Access control framework not demonstrated in this period.',
        action_required: 'Document access control policies. Define access rights per role. Implement access provisioning and deprovisioning procedures.',
        evidence: [{ type: 'l3_policy_gate', events: l3Events.length }]
      },
      {
        ...HIPAA_REQUIREMENTS['164.312(a)(2)(i)'],
        status: uniqueUsers.length > 0 ? 'partial' : 'not_measured',
        findings: uniqueUsers.length > 0
          ? `${uniqueUsers.length} unique identifiers observed in AEE envelope "from" field. However, unique user identification requires formal assignment of unique identifiers and a system to track individual user activity — not just observed envelope fields. Verify that each user has a formally assigned unique ID and that activity can be attributed to specific individuals.`
          : 'No user identifiers observed.',
        action_required: 'Verify all users have formally assigned unique IDs. Implement identity lifecycle management (creation, modification, termination).',
        evidence: [{ type: 'observed_identifiers', count: uniqueUsers.length, note: 'Observed in telemetry — not proof of formal assignment' }]
      },
      {
        ...HIPAA_REQUIREMENTS['164.312(a)(2)(ii)'],
        status: 'requires_action',
        findings: 'Emergency access procedures must establish how authorised users obtain access to ePHI during an emergency. No emergency access procedure evidence found in system telemetry.',
        action_required: 'Document emergency access procedures. Test them. Define who has emergency access rights and under what conditions.',
        evidence: []
      },
      {
        ...HIPAA_REQUIREMENTS['164.312(a)(2)(iii)'],
        status: 'requires_action',
        findings: 'Automatic logoff is an addressable specification. The entity must assess whether automatic session termination is reasonable and appropriate, and if not, document why and implement an alternative.',
        action_required: 'Assess whether automatic logoff is implemented. If not, document the rationale and any alternative measure.',
        evidence: []
      },
      {
        ...HIPAA_REQUIREMENTS['164.312(a)(2)(iv)'],
        status: 'not_measured',
        findings: 'Encryption and decryption is an addressable specification. Server-side AEE data encrypted at field level (AES-256-GCM). "Addressable" does not mean optional — if encryption is not implemented, the entity must document why and what equivalent measure is in place.',
        action_required: 'Document encryption scope. If any ePHI is stored unencrypted, document the risk assessment and alternative safeguards.',
        evidence: [{ type: 'encryption', atRest: 'AES-256-GCM field encryption (server-side)', inTransit: 'HTTPS/TLS' }]
      },

      // Audit Controls
      {
        ...HIPAA_REQUIREMENTS['164.312(b)'],
        status: l10Events.length > 0 ? 'partial' : (envelopes.length > 0 ? 'partial' : 'not_measured'),
        findings: envelopes.length > 0
          ? `${envelopes.length} events logged via AEE protocol. ${l10Events.length} dedicated L10 audit layer events.${l10Events.length === 0 ? ' Note: dedicated audit layer (L10) did not record events in this period — audit evidence relies on general AEE event logging only.' : ''} HHS requires mechanisms to record AND examine activity — logging alone is not sufficient without documented log review procedures.`
          : 'No audit events recorded in period.',
        action_required: 'Implement regular audit log review procedures. Document who reviews logs, how often, and what they look for. Retain logs per §164.316(b).',
        evidence: [{ type: 'audit_capability', total_events: envelopes.length, l10_events: l10Events.length }]
      },

      // Integrity
      {
        ...HIPAA_REQUIREMENTS['164.312(c)(1)'],
        status: l8Events.length > 0 ? 'partial' : 'requires_action',
        findings: l8Events.length > 0
          ? `AOCL L8 Verification layer provides integrity checking (${l8Events.length} verifications in period). Full compliance requires documented integrity policies and procedures covering all ePHI.`
          : 'No integrity verification events recorded. Integrity policies and procedures must be documented.',
        action_required: 'Document ePHI integrity policies. Define what constitutes improper alteration. Implement monitoring beyond L8 verification.',
        evidence: [{ type: 'l8_verification', events: l8Events.length }]
      },
      {
        ...HIPAA_REQUIREMENTS['164.312(c)(2)'],
        status: voltEvidence ? 'partial' : 'not_measured',
        findings: voltEvidence
          ? `VOLT hash-chain verification provides cryptographic integrity authentication: ${voltEvidence.valid_count}/${voltEvidence.verified_sample} bundles verified (${voltEvidence.integrity_rate}% integrity). This is strong technical evidence but covers VOLT-traced operations only, not all ePHI.`
          : 'No VOLT integrity evidence available. This is an addressable specification — assess and document whether ePHI authentication mechanisms are reasonable and appropriate.',
        evidence: voltEvidence ? [{ type: 'volt_integrity', integrity_rate: voltEvidence.integrity_rate }] : []
      },

      // Authentication
      {
        ...HIPAA_REQUIREMENTS['164.312(d)'],
        status: uniqueSessions.length > 0 ? 'partial' : 'requires_action',
        findings: uniqueSessions.length > 0
          ? `${uniqueSessions.length} authenticated sessions observed via AEE correlation IDs. However, person/entity authentication requires verified identity proofing, credential management, and session binding procedures — not just observed session counts. Verify that authentication procedures include identity verification before granting access.`
          : 'No authenticated sessions observed.',
        action_required: 'Document authentication procedures including: identity proofing, credential issuance, multi-factor authentication (if appropriate), and session management.',
        evidence: [{ type: 'observed_sessions', count: uniqueSessions.length, note: 'Observed sessions — not proof of identity verification procedures' }]
      },

      // Transmission Security
      {
        ...HIPAA_REQUIREMENTS['164.312(e)(1)'],
        status: 'not_measured',
        findings: 'HTTPS/TLS configured at infrastructure level. Programmatic verification of TLS enforcement across all ePHI transmission paths not performed. Transmission security is a required standard.',
        action_required: 'Document all ePHI transmission paths. Verify TLS is enforced on each. Document any paths where encryption is not used and the risk assessment for those paths.',
        evidence: [{ type: 'infrastructure', protocol: 'HTTPS/TLS (infrastructure-configured)' }]
      },
      {
        ...HIPAA_REQUIREMENTS['164.312(e)(2)(i)'],
        status: 'not_measured',
        findings: 'AEE envelopes provide message integrity via unique IDs, timestamps, and VOLT hash chains. Programmatic verification of integrity controls across all transmission paths not performed. Addressable specification — assess and document.',
        evidence: [{ type: 'mechanism', description: 'AEE envelopes + VOLT hash chains provide integrity framework' }]
      },
      {
        ...HIPAA_REQUIREMENTS['164.312(e)(2)(ii)'],
        status: 'not_measured',
        findings: 'Encryption in transit via TLS at infrastructure level. Addressable specification — if not implemented for specific paths, document the risk assessment and alternative measures.',
        evidence: [{ type: 'encryption', mechanism: 'TLS (infrastructure-configured)' }]
      },
    ]
  }
}

/**
 * §164.314 — Organisational Requirements
 */
function formatOrganisationalRequirements() {
  return {
    name: 'Organisational Requirements (§164.314)',
    controls: [
      {
        ...HIPAA_REQUIREMENTS['164.314(a)'],
        status: 'requires_action',
        findings: 'If this system is operated by or on behalf of a covered entity, business associate agreements (BAAs) must be in place with entities that create, receive, maintain, or transmit ePHI on behalf of the entity. External AI/LLM vendors (e.g. Anthropic, OpenAI, Google) may be business associates if ePHI is transmitted to their APIs — the classification depends on the specific service arrangement and data handling.',
        action_required: 'Assess whether external AI/LLM providers qualify as business associates under your service arrangement. If so, execute BAAs. HHS cloud computing guidance provides relevant framing for hosted AI services.',
        evidence: []
      },
    ]
  }
}

/**
 * §164.316 — Documentation
 */
function formatDocumentation() {
  return {
    name: 'Policies, Procedures, and Documentation (§164.316)',
    controls: [
      {
        ...HIPAA_REQUIREMENTS['164.316(a)'],
        status: 'requires_action',
        findings: 'All Security Rule standards must be supported by written policies and procedures. These must be reasonable and appropriate for the entity\'s size, complexity, and environment.',
        action_required: 'Document policies and procedures for every Security Rule standard. Review and update as needed.',
        evidence: []
      },
      {
        ...HIPAA_REQUIREMENTS['164.316(b)(1)'],
        status: 'requires_action',
        findings: 'Documentation must be retained for 6 years from date of creation or last effective date. Actions, activities, or assessments required by the Security Rule must be documented.',
        action_required: 'Implement a documentation retention policy with 6-year minimum. Version all policies. Track review dates.',
        evidence: []
      },
    ]
  }
}

/**
 * Risk assessment guidance
 */
function generateRiskAssessmentGuidance(sections) {
  const allControls = Object.values(sections).flatMap(s => s.controls || [])
  const gaps = allControls.filter(c => c.status === 'requires_action' || c.status === 'not_measured')

  return {
    note: 'HHS/OCR considers risk analysis and risk management the foundation of Security Rule compliance. This guidance identifies areas to address in your risk analysis.',
    foundational: 'A risk analysis must: (1) identify all ePHI, (2) identify threats and vulnerabilities, (3) assess current security measures, (4) determine likelihood and impact, (5) determine risk level, (6) document findings.',
    identifiedGaps: gaps.map(c => ({
      requirement: c.id,
      name: c.name,
      status: c.status,
      action: c.action_required || c.findings,
    })),
    retentionRequirement: 'All risk analysis documentation must be retained for 6 years.',
  }
}

export default {
  HIPAA_REQUIREMENTS,
  formatHIPAAReport
}
