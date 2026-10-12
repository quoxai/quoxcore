// MIRROR of src/services/compliance/evidenceMapping.js — canonical author is the frontend file.
// Kept in sync by test/complianceEvidence.parity.test.js. Do not edit thresholds here without
// editing the source.

/**
 * Evidence Mapping Tables — Phase 7.B
 *
 * Central mapping: regulation requirements → VOLT event types + AOCL layers.
 * Used by compliance formatters and the evidence mapping UI to show
 * which requirements are satisfied by recorded evidence.
 */

// VOLT event types that provide evidence
const VOLT_EVENT_TYPES = {
  ENVELOPE_RECEIVED: 'aee.envelope.received',
  ENVELOPE_SENT: 'aee.envelope.sent',
  LAYER_COMPLETED: 'aocl.layer.completed',
  POLICY_EVALUATED: 'aocl.policy.evaluated',
  HITL_REQUESTED: 'hitl.requested',
  HITL_APPROVED: 'hitl.approved',
  HITL_DENIED: 'hitl.denied',
  TOOL_REQUESTED: 'tool.call.requested',
  TOOL_EXECUTED: 'tool.call.executed',
  MODEL_RESPONSE: 'model.response',
  CREDENTIAL_ACCESSED: 'credential.accessed',
  RUN_COMPLETED: 'volt.run.completed',
}

// AOCL layers that provide governance evidence
const AOCL_LAYERS = {
  L0: { id: 'L0', name: 'Input Validation', description: 'Validates incoming request format and content' },
  L1: { id: 'L1', name: 'Identity Resolution', description: 'Resolves actor identity and permissions' },
  L2: { id: 'L2', name: 'Rate Limiting', description: 'Enforces rate limits per actor/resource' },
  L3: { id: 'L3', name: 'Policy Gate', description: 'Evaluates policy rules — can block execution' },
  L4: { id: 'L4', name: 'Routing', description: 'Routes to appropriate agent/service' },
  L5: { id: 'L5', name: 'Context Assembly', description: 'Builds execution context (memory, focus)' },
  L6: { id: 'L6', name: 'Execution', description: 'Runs the agent with tools' },
  L7: { id: 'L7', name: 'Tool Governance', description: 'Validates tool calls against permissions' },
  L8: { id: 'L8', name: 'Response Verification', description: 'Verifies response quality and safety' },
  L9: { id: 'L9', name: 'Delivery', description: 'Delivers response to requester' },
  L10: { id: 'L10', name: 'Audit Commit', description: 'Commits full audit record' },
}

/**
 * SOC 2 Trust Services Criteria mapping
 */
const SOC2_MAPPING = {
  'CC6.1': {
    name: 'Logical Access Security',
    description: 'The entity implements logical access security software, infrastructure, and architectures',
    voltEvents: [VOLT_EVENT_TYPES.ENVELOPE_RECEIVED, VOLT_EVENT_TYPES.ENVELOPE_SENT],
    aoclLayers: ['L1', 'L3'],
    requiredTraceCount: 10,
    evidenceType: 'continuous'
  },
  'CC6.2': {
    name: 'Access Controls',
    description: 'Prior to issuing system credentials and granting system access, the entity registers and authorises new users',
    voltEvents: [VOLT_EVENT_TYPES.CREDENTIAL_ACCESSED],
    aoclLayers: ['L1'],
    requiredTraceCount: 1,
    evidenceType: 'continuous'
  },
  'CC6.3': {
    name: 'Access Removal',
    description: 'The entity removes access to protected information assets when no longer needed',
    voltEvents: [],
    aoclLayers: ['L1'],
    requiredTraceCount: 0,
    evidenceType: 'periodic'
  },
  'CC7.1': {
    name: 'System Monitoring',
    description: 'To meet its objectives, the entity uses detection and monitoring procedures',
    voltEvents: [VOLT_EVENT_TYPES.LAYER_COMPLETED, VOLT_EVENT_TYPES.TOOL_EXECUTED],
    aoclLayers: ['L0', 'L7', 'L8', 'L10'],
    requiredTraceCount: 50,
    evidenceType: 'continuous'
  },
  'CC7.2': {
    name: 'Security Event Monitoring',
    description: 'The entity monitors system components and the operation of those components for anomalies',
    voltEvents: [VOLT_EVENT_TYPES.POLICY_EVALUATED],
    aoclLayers: ['L3', 'L8'],
    requiredTraceCount: 10,
    evidenceType: 'continuous'
  },
  'CC7.3': {
    name: 'Security Incident Evaluation',
    description: 'The entity evaluates security events to determine whether they indicate a failure',
    voltEvents: [VOLT_EVENT_TYPES.HITL_REQUESTED, VOLT_EVENT_TYPES.HITL_DENIED],
    aoclLayers: ['L3', 'L8'],
    requiredTraceCount: 0,
    evidenceType: 'event-driven'
  },
  'CC7.4': {
    name: 'Security Incident Response',
    description: 'The entity responds to identified security incidents',
    voltEvents: [VOLT_EVENT_TYPES.HITL_APPROVED, VOLT_EVENT_TYPES.HITL_DENIED],
    aoclLayers: ['L3'],
    requiredTraceCount: 0,
    evidenceType: 'event-driven'
  },
  'CC8.1': {
    name: 'Change Management',
    description: 'The entity authorises, designs, develops, configures, documents, tests, approves, and implements changes',
    voltEvents: [VOLT_EVENT_TYPES.TOOL_EXECUTED],
    aoclLayers: ['L7'],
    requiredTraceCount: 5,
    evidenceType: 'continuous'
  },
  'PI1.1': {
    name: 'Processing Definition',
    description: 'The entity obtains or generates relevant data regarding the definition of processing',
    voltEvents: [VOLT_EVENT_TYPES.ENVELOPE_RECEIVED],
    aoclLayers: ['L0', 'L5'],
    requiredTraceCount: 10,
    evidenceType: 'continuous'
  },
  'PI1.2': {
    name: 'Processing Inputs',
    description: 'The entity implements policies and procedures over system inputs',
    voltEvents: [VOLT_EVENT_TYPES.ENVELOPE_RECEIVED, VOLT_EVENT_TYPES.LAYER_COMPLETED],
    aoclLayers: ['L0'],
    requiredTraceCount: 10,
    evidenceType: 'continuous'
  },
  'PI1.3': {
    name: 'Processing Completeness',
    description: 'The entity implements policies and procedures over system processing',
    voltEvents: [VOLT_EVENT_TYPES.LAYER_COMPLETED, VOLT_EVENT_TYPES.TOOL_EXECUTED],
    aoclLayers: ['L7', 'L8'],
    requiredTraceCount: 10,
    evidenceType: 'continuous'
  },
  'PI1.4': {
    name: 'Processing Outputs',
    description: 'The entity implements policies and procedures over system outputs',
    voltEvents: [VOLT_EVENT_TYPES.MODEL_RESPONSE, VOLT_EVENT_TYPES.ENVELOPE_SENT],
    aoclLayers: ['L8', 'L9'],
    requiredTraceCount: 10,
    evidenceType: 'continuous'
  },
  'PI1.5': {
    name: 'Evidence Bundle Verification',
    description: 'The entity verifies the integrity of processing through cryptographic evidence chains',
    voltEvents: [VOLT_EVENT_TYPES.RUN_COMPLETED],
    aoclLayers: ['L10'],
    requiredIntegrityRate: 95,
    evidenceType: 'continuous'
  },
  'A1.1': {
    name: 'Availability Commitments',
    description: 'The entity maintains, monitors, and evaluates current processing capacity and usage',
    voltEvents: [VOLT_EVENT_TYPES.RUN_COMPLETED],
    aoclLayers: [],
    requiredSuccessRate: 99,
    evidenceType: 'continuous'
  },
  'A1.2': {
    name: 'Recovery Objectives',
    description: 'RTO/RPO defined for critical systems; backup and recovery procedures maintained',
    voltEvents: [],
    aoclLayers: [],
    evidenceType: 'organisational',
    required: true
  },
  'A1.3': {
    name: 'Recovery Testing',
    description: 'Periodic testing of recovery procedures (backup restoration drills, failover tests)',
    voltEvents: [],
    aoclLayers: [],
    evidenceType: 'periodic',
    required: true
  }
}

/**
 * HIPAA Technical Safeguards mapping
 */
const HIPAA_MAPPING = {
  '164.312(a)(1)': {
    name: 'Access Controls',
    description: 'Implement technical policies and procedures for electronic information systems',
    voltEvents: [VOLT_EVENT_TYPES.ENVELOPE_RECEIVED, VOLT_EVENT_TYPES.CREDENTIAL_ACCESSED],
    aoclLayers: ['L1', 'L3'],
    evidenceType: 'continuous'
  },
  '164.312(a)(2)(i)': {
    name: 'Unique User Identification',
    description: 'Assign a unique name and/or number for identifying and tracking user identity',
    voltEvents: [VOLT_EVENT_TYPES.ENVELOPE_RECEIVED],
    aoclLayers: ['L1'],
    evidenceType: 'continuous'
  },
  '164.312(b)': {
    name: 'Audit Controls',
    description: 'Implement hardware, software, and/or procedural mechanisms that record and examine activity',
    voltEvents: [VOLT_EVENT_TYPES.LAYER_COMPLETED, VOLT_EVENT_TYPES.TOOL_EXECUTED, VOLT_EVENT_TYPES.MODEL_RESPONSE],
    aoclLayers: ['L0', 'L5', 'L7', 'L10'],
    requiredTraceCount: 100,
    evidenceType: 'continuous'
  },
  '164.312(c)(1)': {
    name: 'Integrity Controls',
    description: 'Implement policies and procedures to protect electronic protected health information from improper alteration',
    voltEvents: [VOLT_EVENT_TYPES.RUN_COMPLETED],
    aoclLayers: ['L8'],
    evidenceType: 'continuous'
  },
  '164.312(c)(3)': {
    name: 'VOLT Integrity Verification',
    description: 'Mechanism to authenticate and verify integrity of electronic protected health information',
    voltEvents: [VOLT_EVENT_TYPES.RUN_COMPLETED],
    aoclLayers: ['L10'],
    requiredIntegrityRate: 95,
    evidenceType: 'continuous'
  },
  '164.312(d)': {
    name: 'Person or Entity Authentication',
    description: 'Implement procedures to verify that a person or entity seeking access is the one claimed',
    voltEvents: [VOLT_EVENT_TYPES.ENVELOPE_RECEIVED],
    aoclLayers: ['L1'],
    evidenceType: 'continuous'
  },
  '164.312(e)(1)': {
    name: 'Transmission Security',
    description: 'Implement technical security measures to guard against unauthorised access to ePHI transmitted over a network',
    voltEvents: [],
    aoclLayers: ['L0'],
    evidenceType: 'configuration'
  }
}

/**
 * GDPR mapping
 */
const GDPR_MAPPING = {
  'Art.5(1)(a)': {
    name: 'Lawfulness, fairness and transparency',
    description: 'Personal data shall be processed lawfully, fairly and in a transparent manner',
    voltEvents: [VOLT_EVENT_TYPES.POLICY_EVALUATED],
    aoclLayers: ['L3', 'L5'],
    evidenceType: 'continuous'
  },
  'Art.5(1)(b)': {
    name: 'Purpose limitation',
    description: 'Collected for specified, explicit and legitimate purposes',
    voltEvents: [VOLT_EVENT_TYPES.ENVELOPE_RECEIVED],
    aoclLayers: ['L3'],
    evidenceType: 'continuous'
  },
  'Art.5(1)(c)': {
    name: 'Data minimisation',
    description: 'Adequate, relevant and limited to what is necessary',
    voltEvents: [],
    aoclLayers: ['L5', 'L8'],
    evidenceType: 'design'
  },
  'Art.5(1)(f)': {
    name: 'Integrity and confidentiality',
    description: 'Processed in a manner that ensures appropriate security',
    voltEvents: [VOLT_EVENT_TYPES.RUN_COMPLETED, VOLT_EVENT_TYPES.CREDENTIAL_ACCESSED],
    aoclLayers: ['L1', 'L3', 'L10'],
    evidenceType: 'continuous'
  },
  'Art.25': {
    name: 'Data protection by design and by default',
    description: 'Implement appropriate technical and organisational measures',
    voltEvents: [VOLT_EVENT_TYPES.LAYER_COMPLETED],
    aoclLayers: ['L0', 'L1', 'L3', 'L7', 'L8'],
    evidenceType: 'design'
  },
  'Art.30': {
    name: 'Records of processing activities',
    description: 'Each controller shall maintain a record of processing activities',
    voltEvents: [VOLT_EVENT_TYPES.ENVELOPE_RECEIVED, VOLT_EVENT_TYPES.ENVELOPE_SENT, VOLT_EVENT_TYPES.TOOL_EXECUTED],
    aoclLayers: ['L10'],
    requiredTraceCount: 100,
    evidenceType: 'continuous'
  },
  'Art.32(1)(a)': {
    name: 'Pseudonymisation and encryption',
    description: 'The pseudonymisation and encryption of personal data',
    voltEvents: [VOLT_EVENT_TYPES.CREDENTIAL_ACCESSED],
    aoclLayers: ['L1'],
    evidenceType: 'configuration'
  },
  'Art.32(1)(b)': {
    name: 'Confidentiality and integrity',
    description: 'The ability to ensure ongoing confidentiality, integrity, availability and resilience',
    voltEvents: [VOLT_EVENT_TYPES.RUN_COMPLETED],
    aoclLayers: ['L3', 'L8', 'L10'],
    evidenceType: 'continuous'
  },
  'Art.33': {
    name: 'Breach notification to authority',
    description: 'Notification of a personal data breach to the supervisory authority',
    voltEvents: [VOLT_EVENT_TYPES.HITL_REQUESTED],
    aoclLayers: ['L3'],
    evidenceType: 'event-driven'
  },
  'Art.34': {
    name: 'Breach notification to data subject',
    description: 'Communication of a personal data breach to the data subject',
    voltEvents: [VOLT_EVENT_TYPES.HITL_REQUESTED],
    aoclLayers: [],
    evidenceType: 'event-driven'
  }
}

/**
 * EU AI Act mapping (high-risk AI system requirements)
 */
const EU_AI_ACT_MAPPING = {
  'Art.9': {
    name: 'Risk Management System',
    description: 'A risk management system shall be established, implemented, documented and maintained',
    voltEvents: [VOLT_EVENT_TYPES.POLICY_EVALUATED],
    aoclLayers: ['L3', 'L8'],
    evidenceType: 'continuous',
    required: true
  },
  'Art.12': {
    name: 'Record-keeping',
    description: 'High-risk AI systems shall technically allow for the automatic recording of events (logs)',
    voltEvents: [VOLT_EVENT_TYPES.ENVELOPE_RECEIVED, VOLT_EVENT_TYPES.ENVELOPE_SENT, VOLT_EVENT_TYPES.TOOL_EXECUTED, VOLT_EVENT_TYPES.MODEL_RESPONSE],
    aoclLayers: ['L0', 'L5', 'L6', 'L7', 'L10'],
    requiredTraceCount: 100,
    evidenceType: 'continuous',
    required: true
  },
  'Art.13': {
    name: 'Transparency and provision of information',
    description: 'High-risk AI systems shall be designed and developed to ensure their operation is sufficiently transparent',
    voltEvents: [VOLT_EVENT_TYPES.LAYER_COMPLETED, VOLT_EVENT_TYPES.POLICY_EVALUATED],
    aoclLayers: ['L5', 'L8'],
    evidenceType: 'design',
    required: true
  },
  'Art.14': {
    name: 'Human oversight',
    description: 'High-risk AI systems shall be designed and developed to be effectively overseen by natural persons',
    voltEvents: [VOLT_EVENT_TYPES.HITL_REQUESTED, VOLT_EVENT_TYPES.HITL_APPROVED, VOLT_EVENT_TYPES.HITL_DENIED],
    aoclLayers: ['L3'],
    evidenceType: 'continuous',
    required: true
  },
  'Art.15': {
    name: 'Accuracy, robustness and cybersecurity',
    description: 'High-risk AI systems shall be designed and developed to achieve appropriate accuracy. NOTE: requiredIntegrityRate below refers to data integrity (VOLT hash chain), NOT model accuracy. Model accuracy metrics require ML infrastructure not covered by this formatter.',
    voltEvents: [VOLT_EVENT_TYPES.RUN_COMPLETED],
    aoclLayers: ['L8', 'L10'],
    requiredIntegrityRate: 95,
    evidenceType: 'continuous',
    required: true
  },
  'Art.43': {
    name: 'Conformity assessment',
    description: 'The provider shall perform the relevant conformity assessment procedure for high-risk AI systems (per final regulation; Art.62 in earlier drafts).',
    voltEvents: [VOLT_EVENT_TYPES.RUN_COMPLETED],
    aoclLayers: ['L0', 'L1', 'L3', 'L5', 'L7', 'L8', 'L10'],
    evidenceType: 'periodic',
    required: false
  },
  'Art.72': {
    name: 'Post-Market Monitoring',
    description: 'Providers shall establish and document a post-market monitoring system proportionate to the nature of the AI technologies and the risks of the high-risk AI system.',
    voltEvents: [VOLT_EVENT_TYPES.RUN_COMPLETED, VOLT_EVENT_TYPES.LAYER_COMPLETED],
    aoclLayers: ['L10'],
    evidenceType: 'on-demand',
    required: false
  }
}

/**
 * ISO 27001:2022 Annex A Controls mapping
 */
const ISO27001_MAPPING = {
  'A.5.1': {
    name: 'Policies for information security',
    description: 'Information security policy and topic-specific policies shall be defined',
    voltEvents: [VOLT_EVENT_TYPES.POLICY_EVALUATED],
    aoclLayers: ['L3'],
    evidenceType: 'configuration'
  },
  'A.5.2': {
    name: 'Information security roles and responsibilities',
    description: 'Information security roles and responsibilities shall be defined and allocated',
    voltEvents: [VOLT_EVENT_TYPES.ENVELOPE_RECEIVED],
    aoclLayers: ['L1'],
    evidenceType: 'configuration'
  },
  'A.5.7': {
    name: 'Threat intelligence',
    description: 'Information relating to information security threats shall be collected and analysed',
    voltEvents: [VOLT_EVENT_TYPES.POLICY_EVALUATED],
    aoclLayers: ['L3', 'L8'],
    evidenceType: 'continuous'
  },
  'A.5.23': {
    name: 'Information security for use of cloud services',
    description: 'Processes for acquisition, use, management and exit from cloud services shall be established',
    voltEvents: [VOLT_EVENT_TYPES.CREDENTIAL_ACCESSED, VOLT_EVENT_TYPES.TOOL_EXECUTED],
    aoclLayers: ['L1', 'L7'],
    evidenceType: 'continuous'
  },
  'A.5.28': {
    name: 'Collection of evidence',
    description: 'Procedures for the identification, collection, acquisition and preservation of evidence',
    voltEvents: [VOLT_EVENT_TYPES.RUN_COMPLETED, VOLT_EVENT_TYPES.LAYER_COMPLETED],
    aoclLayers: ['L10'],
    requiredIntegrityRate: 95,
    evidenceType: 'continuous'
  },
  'A.8.2': {
    name: 'Privileged access rights',
    description: 'The allocation and use of privileged access rights shall be restricted and managed',
    voltEvents: [VOLT_EVENT_TYPES.CREDENTIAL_ACCESSED],
    aoclLayers: ['L1', 'L3'],
    evidenceType: 'continuous'
  },
  'A.8.3': {
    name: 'Information access restriction',
    description: 'Access to information and other associated assets shall be restricted',
    voltEvents: [VOLT_EVENT_TYPES.POLICY_EVALUATED],
    aoclLayers: ['L1', 'L3'],
    evidenceType: 'continuous'
  },
  'A.8.5': {
    name: 'Secure authentication',
    description: 'Secure authentication technologies and procedures shall be established',
    voltEvents: [VOLT_EVENT_TYPES.ENVELOPE_RECEIVED],
    aoclLayers: ['L1'],
    evidenceType: 'continuous'
  },
  'A.8.9': {
    name: 'Configuration management',
    description: 'Configurations including security configurations shall be established, documented, implemented',
    voltEvents: [VOLT_EVENT_TYPES.TOOL_EXECUTED],
    aoclLayers: ['L7'],
    evidenceType: 'periodic'
  },
  'A.8.15': {
    name: 'Logging',
    description: 'Logs that record activities, exceptions, faults and other relevant events shall be produced',
    voltEvents: [VOLT_EVENT_TYPES.ENVELOPE_RECEIVED, VOLT_EVENT_TYPES.ENVELOPE_SENT, VOLT_EVENT_TYPES.LAYER_COMPLETED, VOLT_EVENT_TYPES.TOOL_EXECUTED],
    aoclLayers: ['L0', 'L10'],
    requiredTraceCount: 100,
    evidenceType: 'continuous'
  },
  'A.8.16': {
    name: 'Monitoring activities',
    description: 'Networks, systems and applications shall be monitored for anomalous behaviour',
    voltEvents: [VOLT_EVENT_TYPES.POLICY_EVALUATED, VOLT_EVENT_TYPES.LAYER_COMPLETED],
    aoclLayers: ['L3', 'L8'],
    evidenceType: 'continuous'
  }
}

/**
 * ISO/IEC 42001:2023 — AI Management System (CTL-LIB-4)
 */
const ISO42001_MAPPING = {
  'Cl.8.1': {
    name: 'Operational planning and control',
    description: 'Control of AI system operations — strongest Quox coverage via AOCL policy enforcement',
    voltEvents: [VOLT_EVENT_TYPES.LAYER_COMPLETED, VOLT_EVENT_TYPES.POLICY_EVALUATED],
    aoclLayers: ['L3', 'L7'],
    requiredTraceCount: 10,
    evidenceType: 'continuous'
  },
  'Cl.9.1': {
    name: 'Monitoring, measurement, analysis, evaluation',
    description: 'Continuous monitoring of AIMS performance — VOLT hash chain + L8 verification',
    voltEvents: [VOLT_EVENT_TYPES.RUN_COMPLETED, VOLT_EVENT_TYPES.LAYER_COMPLETED],
    aoclLayers: ['L8', 'L10'],
    requiredTraceCount: 10,
    evidenceType: 'continuous'
  },
  'Cl.9.2': {
    name: 'Internal audit',
    description: 'Planned AIMS internal audits',
    voltEvents: [],
    aoclLayers: [],
    evidenceType: 'periodic',
    required: true
  },
}

/**
 * NIST AI Risk Management Framework 1.0 (CTL-LIB-5)
 */
const NIST_AI_RMF_MAPPING = {
  'MEASURE-2.3': {
    name: 'Measurement environments',
    description: 'Regular measurement of AI system performance with VOLT/L8',
    voltEvents: [VOLT_EVENT_TYPES.RUN_COMPLETED],
    aoclLayers: ['L8'],
    requiredTraceCount: 10,
    evidenceType: 'continuous'
  },
  'MEASURE-2.4': {
    name: 'Ongoing monitoring',
    description: 'Continuous monitoring via VOLT hash chain integrity',
    voltEvents: [VOLT_EVENT_TYPES.RUN_COMPLETED, VOLT_EVENT_TYPES.LAYER_COMPLETED],
    aoclLayers: ['L8', 'L10'],
    requiredTraceCount: 10,
    evidenceType: 'continuous'
  },
  'MANAGE-2.4': {
    name: 'Incident response',
    description: 'HITL approval events + DEFCON escalations + incident envelopes',
    voltEvents: [VOLT_EVENT_TYPES.HITL_REQUESTED, VOLT_EVENT_TYPES.HITL_APPROVED, VOLT_EVENT_TYPES.HITL_DENIED],
    aoclLayers: ['L3'],
    evidenceType: 'event-driven'
  },
  'MANAGE-1.2': {
    name: 'Response planning',
    description: 'HITL workflows for risk response',
    voltEvents: [VOLT_EVENT_TYPES.HITL_REQUESTED, VOLT_EVENT_TYPES.HITL_APPROVED],
    aoclLayers: ['L3'],
    evidenceType: 'event-driven'
  },
}

const FRAMEWORKS = {
  soc2: { name: 'SOC 2', mapping: SOC2_MAPPING, description: 'AICPA Trust Services Criteria' },
  hipaa: { name: 'HIPAA', mapping: HIPAA_MAPPING, description: 'Health Insurance Portability and Accountability Act' },
  gdpr: { name: 'GDPR', mapping: GDPR_MAPPING, description: 'General Data Protection Regulation' },
  iso27001: { name: 'ISO 27001', mapping: ISO27001_MAPPING, description: 'Information Security Management Systems' },
  euAiAct: { name: 'EU AI Act', mapping: EU_AI_ACT_MAPPING, description: 'European Union Artificial Intelligence Act' },
  iso42001: { name: 'ISO 42001', mapping: ISO42001_MAPPING, description: 'ISO/IEC 42001 Artificial Intelligence Management System' },
  nistAiRmf: { name: 'NIST AI RMF', mapping: NIST_AI_RMF_MAPPING, description: 'NIST AI Risk Management Framework 1.0' },
}

/**
 * Given trace data, evaluate coverage for a specific framework.
 *
 * @param {string} frameworkId - e.g. 'soc2', 'euAiAct'
 * @param {Object} traceData - from gatherTraceData()
 * @param {Object} voltEvidence - from gatherVoltEvidence()
 * @returns {{ controls: Array, coverage: number, satisfied: number, total: number }}
 */
function evaluateFrameworkCoverage(frameworkId, traceData, voltEvidence) {
  const framework = FRAMEWORKS[frameworkId]
  if (!framework) return { controls: [], coverage: 0, satisfied: 0, total: 0 }

  const mapping = framework.mapping
  const controls = []
  let satisfied = 0

  for (const [controlId, control] of Object.entries(mapping)) {
    // Count matching events
    const eventCounts = {}
    let totalEvents = 0

    if (traceData?.envelopes) {
      for (const eventType of (control.voltEvents || [])) {
        const count = traceData.envelopes.filter(e => {
          // Map AEE envelope to VOLT event type
          if (eventType === VOLT_EVENT_TYPES.ENVELOPE_RECEIVED && e.type === 'task') return true
          if (eventType === VOLT_EVENT_TYPES.ENVELOPE_SENT && (e.type === 'result' || e.type === 'event')) return true
          if (eventType === VOLT_EVENT_TYPES.POLICY_EVALUATED && e.intent?.startsWith('aocl.policy')) return true
          if (eventType === VOLT_EVENT_TYPES.HITL_REQUESTED && e.intent?.includes('approval')) return true
          if (eventType === VOLT_EVENT_TYPES.TOOL_EXECUTED && e.intent?.includes('tool')) return true
          return false
        }).length
        eventCounts[eventType] = count
        totalEvents += count
      }
    }

    // Count matching layer events
    const layerCounts = {}
    if (traceData?.layerEvents) {
      for (const layerId of (control.aoclLayers || [])) {
        const count = traceData.layerEvents.filter(le => le.layer === layerId).length
        layerCounts[layerId] = count
        totalEvents += count
      }
    }

    // Determine compliance status
    let status = 'unknown'
    let coveragePercent = 0

    if (control.requiredIntegrityRate != null && voltEvidence) {
      const rate = voltEvidence.integrity_rate || 0
      coveragePercent = Math.min(100, Math.round((rate / control.requiredIntegrityRate) * 100))
      status = rate >= control.requiredIntegrityRate ? 'compliant' : 'non-compliant'
    } else if (control.requiredSuccessRate != null && voltEvidence) {
      // Use integrity_rate (already a %) since valid_count is sample-scoped
      const successRate = voltEvidence.integrity_rate || 0
      coveragePercent = Math.min(100, Math.round((successRate / control.requiredSuccessRate) * 100))
      status = successRate >= control.requiredSuccessRate ? 'compliant' : 'non-compliant'
    } else if (control.requiredTraceCount != null && control.requiredTraceCount > 0) {
      coveragePercent = Math.min(100, Math.round((totalEvents / control.requiredTraceCount) * 100))
      // Zero evidence = not assessed (unknown), not a compliance failure ('non-compliant' is
      // reserved for controls where evidence EXISTS but is deficient).
      status = totalEvents >= control.requiredTraceCount ? 'compliant' : (totalEvents > 0 ? 'partial' : 'unknown')
    } else if (control.evidenceType === 'configuration' || control.evidenceType === 'design') {
      // Config/design evidence is structural — mark as compliant if AOCL layers are active
      const hasLayers = (control.aoclLayers || []).some(l => (layerCounts[l] || 0) > 0)
      status = hasLayers ? 'compliant' : 'unknown'
      coveragePercent = hasLayers ? 100 : 0
    } else if (control.evidenceType === 'event-driven') {
      // Event-driven controls require at least one recorded event to count as compliant;
      // zero events means not assessed, not a pass-by-default.
      status = totalEvents > 0 ? 'compliant' : 'unknown'
      coveragePercent = totalEvents > 0 ? 100 : 0
    } else {
      // Default: any evidence counts
      status = totalEvents > 0 ? 'compliant' : 'unknown'
      coveragePercent = totalEvents > 0 ? 100 : 0
    }

    if (status === 'compliant') satisfied++

    controls.push({
      id: controlId,
      ...control,
      eventCounts,
      layerCounts,
      totalEvents,
      status,
      coveragePercent
    })
  }

  const total = Object.keys(mapping).length

  return {
    controls,
    coverage: total > 0 ? Math.round((satisfied / total) * 100) : 0,
    satisfied,
    total,
    framework: framework.name
  }
}

module.exports = {
  VOLT_EVENT_TYPES,
  AOCL_LAYERS,
  SOC2_MAPPING,
  HIPAA_MAPPING,
  GDPR_MAPPING,
  EU_AI_ACT_MAPPING,
  ISO27001_MAPPING,
  ISO42001_MAPPING,
  NIST_AI_RMF_MAPPING,
  FRAMEWORKS,
  evaluateFrameworkCoverage,
}
