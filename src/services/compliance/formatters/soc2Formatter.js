/**
 * SOC 2 Compliance Formatter
 *
 * Maps AOCL trace data to SOC 2 Trust Services Criteria:
 * - CC6: Logical and Physical Access Controls
 * - CC7: System Operations
 * - CC8: Change Management
 * - PI1: Processing Integrity
 * - A1: Availability
 */

/**
 * SOC 2 Trust Services Criteria definitions
 */
export const SOC2_CRITERIA = {
  CC6_1: {
    id: 'CC6.1',
    name: 'Logical Access Security',
    description: 'The entity implements logical access security software, infrastructure, and architectures to protect information assets.',
    category: 'Common Criteria'
  },
  CC6_2: {
    id: 'CC6.2',
    name: 'Access Controls',
    description: 'Prior to issuing system credentials and granting system access, the entity registers and authorizes new internal and external users.',
    category: 'Common Criteria'
  },
  CC6_3: {
    id: 'CC6.3',
    name: 'Access Removal',
    description: 'The entity removes access to protected information assets when appropriate.',
    category: 'Common Criteria'
  },
  CC7_1: {
    id: 'CC7.1',
    name: 'System Monitoring',
    description: 'To meet its objectives, the entity uses detection and monitoring procedures to identify changes to configurations.',
    category: 'Common Criteria'
  },
  CC7_2: {
    id: 'CC7.2',
    name: 'Security Event Monitoring',
    description: 'The entity monitors system components and the operation of those components for anomalies.',
    category: 'Common Criteria'
  },
  CC7_3: {
    id: 'CC7.3',
    name: 'Security Incident Evaluation',
    description: 'The entity evaluates security events to determine whether they could or have resulted in a failure.',
    category: 'Common Criteria'
  },
  CC7_4: {
    id: 'CC7.4',
    name: 'Security Incident Response',
    description: 'The entity responds to identified security incidents by executing a defined incident response program.',
    category: 'Common Criteria'
  },
  CC8_1: {
    id: 'CC8.1',
    name: 'Change Management',
    description: 'The entity authorizes, designs, develops, configures, documents, tests, approves, and implements changes.',
    category: 'Common Criteria'
  },
  PI1_1: {
    id: 'PI1.1',
    name: 'Processing Integrity Policies',
    description: 'The entity obtains or generates, uses, and communicates relevant information regarding objectives.',
    category: 'Processing Integrity'
  },
  PI1_2: {
    id: 'PI1.2',
    name: 'System Input Controls',
    description: 'The entity implements controls over system inputs.',
    category: 'Processing Integrity'
  },
  PI1_3: {
    id: 'PI1.3',
    name: 'Processing Controls',
    description: 'The entity implements controls over processing.',
    category: 'Processing Integrity'
  },
  PI1_4: {
    id: 'PI1.4',
    name: 'System Output Controls',
    description: 'The entity implements controls over system outputs.',
    category: 'Processing Integrity'
  },
  A1_1: {
    id: 'A1.1',
    name: 'Availability Commitments',
    description: 'The entity maintains, monitors, and evaluates current processing capacity.',
    category: 'Availability'
  },
  A1_2: {
    id: 'A1.2',
    name: 'Recovery Objectives',
    description: 'The entity defines recovery point objective (RPO) and recovery time objective (RTO) for critical systems, and maintains backup and recovery procedures.',
    category: 'Availability'
  },
  A1_3: {
    id: 'A1.3',
    name: 'Recovery Testing',
    description: 'The entity periodically tests recovery procedures, including backup restoration drills, to verify the effectiveness of availability controls.',
    category: 'Availability'
  }
}

/**
 * Format trace data as SOC 2 compliance report
 * @param {Object} traceData - Gathered trace data
 * @param {Object} period - Report period
 * @param {Object} baseReport - Base report metadata
 * @returns {Object} SOC 2 formatted report
 */
export function formatSOC2Report(traceData, period, baseReport) {
  const { envelopes, layerEvents, conversations, policyDecisions, voltEvidence } = traceData

  // Analyze trace data for each criterion
  const sections = {
    CC6: formatAccessControls(traceData),
    CC7: formatSystemOperations(traceData),
    CC8: formatChangeManagement(traceData),
    PI1: formatProcessingIntegrity(traceData, voltEvidence),
    A1: formatAvailability(traceData)
  }

  // Calculate overall compliance score
  // Conservative scoring: compliant=1.0, partial=0.5, non-compliant/gap=0, not_measured excluded
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
  const notMeasuredCount = allControls.filter(c => c.status === 'not_measured').length
  const partialCount = allControls.filter(c => c.status === 'partial').length

  // Conservative status: any partial or not_measured prevents "compliant" headline
  // FMT-FIX: Align with other formatters — use readiness language, not "compliant" headline.
  // Only a licensed CPA firm can issue a SOC 2 opinion; this is a readiness assessment.
  const requiresActionCount = allControls.filter(c => c.status === 'requires_action').length
  let overallStatus = 'material_gaps'
  if (overallScore >= 90 && partialCount === 0 && notMeasuredCount === 0 && requiresActionCount === 0) overallStatus = 'substantially_aligned'
  else if (overallScore >= 70) overallStatus = 'partially_evidenced'
  else if (requiresActionCount > 0) overallStatus = 'action_required'

  return {
    ...baseReport,
    framework: 'SOC 2 Type II',
    trustServiceCategories: ['Security', 'Processing Integrity', 'Availability'],
    overallScore,
    overallStatus,
    sections,
    findings: generateFindings(sections),
    recommendations: generateRecommendations(sections),
    scope: generateScopeStatement(period),
    attestation: generateAttestationTemplate(),
    typeGuidance: generateTypeGuidance(),
  }
}

/**
 * FMT-V2-2: Scope statement template
 */
function generateScopeStatement(period) {
  const periodDays = typeof period === 'number' ? period : (period?.days || 30)
  return {
    systems: '[CONFIGURE: Systems in scope — list production AI systems, agents, and infrastructure covered by this assessment]',
    period: `${periodDays} days (configurable per audit engagement)`,
    controls: ['CC6 — Common Criteria: Logical Access', 'CC7 — System Operations', 'CC8 — Change Management', 'PI1 — Processing Integrity', 'A1 — Availability'],
    exclusions: '[Document any controls excluded from scope with justification]',
    methodology: 'Automated evidence collection via AOCL governance layers (L0-L10), VOLT operations ledger, AEE audit envelopes, and WARD external witness chain.',
  }
}

/**
 * FMT-V2-2: Management attestation template
 */
function generateAttestationTemplate() {
  return {
    text: 'Management is responsible for designing, implementing, and maintaining controls. This assessment is a technical readiness evaluation and does not constitute a formal SOC 2 opinion. A licensed CPA firm must perform the formal examination for an issued SOC 2 report.',
    signature_fields: [
      { role: 'Chief Executive Officer (CEO)', name: '', date: '', title: 'Chief Executive Officer' },
      { role: 'Chief Technology Officer (CTO)', name: '', date: '', title: 'Chief Technology Officer' },
      { role: 'Information Security Officer', name: '', date: '', title: 'CISO / Security Officer' },
    ],
  }
}

/**
 * FMT-V2-2: Type I vs Type II guidance
 */
function generateTypeGuidance() {
  return {
    typeI: 'Type I reports describe controls at a point in time. Auditor confirms controls are designed appropriately as of a specific date.',
    typeII: 'Type II reports describe controls over a period and confirm they operated effectively. Minimum period: 6 months (some auditors accept 3 months for initial reports). Standard practice is a 6-12 month examination period.',
    recommendation: 'For enterprise sales and continuous assurance, a 12-month Type II report is strongly preferred. Plan evidence collection to cover the full 6-12 month examination period before engaging a CPA firm.',
  }
}

/**
 * Format CC6: Logical and Physical Access Controls
 */
function formatAccessControls(traceData) {
  const { envelopes, policyDecisions } = traceData

  // Count access-related events
  const accessEvents = envelopes.filter(e =>
    e.intent?.includes('auth') ||
    e.intent?.includes('access') ||
    e.from?.startsWith('human.')
  )

  // Count policy enforcement (L3)
  const policyBlocks = policyDecisions.filter(e =>
    e.payload?.status === 'reject' || e.payload?.allowed === false
  )

  return {
    name: 'Logical and Physical Access Controls',
    controls: [
      {
        ...SOC2_CRITERIA.CC6_1,
        status: 'compliant',
        findings: `${accessEvents.length} access events logged. AOCL provides complete audit trail.`,
        evidence: accessEvents.slice(0, 10).map(e => ({
          id: e.id,
          timestamp: e.ts,
          type: 'access_log',
          summary: `${e.from} → ${e.to}: ${e.intent}`
        }))
      },
      {
        ...SOC2_CRITERIA.CC6_2,
        status: 'compliant',
        findings: 'User identification tracked via AEE envelope "from" field.',
        evidence: [...new Set(envelopes.map(e => e.from).filter(Boolean))].map(user => ({
          type: 'user_identity',
          user,
          eventCount: envelopes.filter(e => e.from === user).length
        }))
      },
      {
        ...SOC2_CRITERIA.CC6_3,
        status: policyBlocks.length > 0 ? 'compliant' : 'partial',
        findings: `${policyBlocks.length} policy enforcement actions recorded via L3 Policy Gate.`,
        evidence: policyBlocks.slice(0, 10).map(e => ({
          id: e.id,
          timestamp: e.ts,
          type: 'policy_block',
          reason: e.payload?.reason
        }))
      }
    ]
  }
}

/**
 * Format CC7: System Operations
 */
function formatSystemOperations(traceData) {
  const { layerEvents, envelopes } = traceData

  // L7 execution events
  const executionEvents = layerEvents.filter(e =>
    e.payload?.layer === 'L7' || e.intent?.includes('delegate')
  )

  // Error events — separate security anomalies from operational errors
  const allErrors = envelopes.filter(e => e.type === 'error')
  const securityAnomalies = allErrors.filter(e => {
    const intent = e.intent || ''
    const msg = String(e.payload?.message || e.payload?.error || '').toLowerCase()
    return intent.includes('policy') || intent.includes('reject') || intent.includes('block')
      || msg.includes('injection') || msg.includes('credential') || msg.includes('unauthorized')
      || msg.includes('denied') || msg.includes('violation')
  })
  const operationalErrors = allErrors.filter(e => !securityAnomalies.includes(e))

  // L8 verification events
  const verificationEvents = layerEvents.filter(e =>
    e.payload?.layer === 'L8' || e.intent?.includes('verify')
  )

  return {
    name: 'System Operations',
    controls: [
      {
        ...SOC2_CRITERIA.CC7_1,
        status: executionEvents.length > 0 ? 'compliant' : 'not_measured',
        findings: executionEvents.length > 0
          ? `AOCL monitors all processing with ${layerEvents.length} layer events. ${executionEvents.length} L7 execution events captured.`
          : 'No AOCL layer events recorded in period.',
        evidence: layerEvents.slice(0, 10).map(e => ({
          id: e.id,
          timestamp: e.ts,
          layer: e.payload?.layer,
          status: e.payload?.status
        }))
      },
      {
        ...SOC2_CRITERIA.CC7_2,
        status: executionEvents.length > 0 ? 'compliant' : 'not_measured',
        findings: `${executionEvents.length} execution events monitored. ${securityAnomalies.length} security anomalies detected, ${operationalErrors.length} operational errors (API timeouts, quota, etc. — excluded from anomaly count).`,
        evidence: securityAnomalies.slice(0, 10).map(e => ({
          id: e.id,
          timestamp: e.ts,
          type: 'security_anomaly',
          summary: e.payload?.message || e.payload?.error || 'Security event detected'
        }))
      },
      {
        ...SOC2_CRITERIA.CC7_3,
        // CRP-BE-6: Fixed inverted logic. Compliant when verification layer is active (L8 events exist).
        status: verificationEvents.length > 0 ? 'compliant' : 'not_measured',
        findings: `Security events evaluated via L8 Verification layer. ${verificationEvents.length} verification checks performed. ${allErrors.length} error events detected and evaluated.`,
        evidence: verificationEvents.slice(0, 10).map(e => ({
          id: e.id,
          timestamp: e.ts,
          type: 'verification',
          result: e.payload?.status
        }))
      },
      {
        ...SOC2_CRITERIA.CC7_4,
        // CRP-BE-6: Honest status — compliant only if error events exist (incident response demonstrated)
        status: allErrors.length > 0 ? 'compliant' : 'not_measured',
        findings: allErrors.length > 0
          ? `Incident response tracked: ${allErrors.length} error events recorded and evaluated via AOCL audit trail.`
          : 'No error events recorded in period — incident response capability not demonstrated.',
        evidence: allErrors.slice(0, 5).map(e => ({
          id: e.id,
          timestamp: e.ts,
          type: 'incident',
          response: 'Logged and tracked'
        })),
        // FMT-V2-2 / FMT-FIX: Structured incident response — honest counts only
        // Detection = actual events detected. Triage/containment/recovery counts
        // represent "incidents requiring X" not "incidents where X was performed"
        // because Quox cannot observe manual triage/recovery actions.
        incidentResponse: {
          detection: {
            count: allErrors.length + verificationEvents.filter(e => e.payload?.status === 'reject').length,
            sources: ['AEE error envelopes', 'AOCL L8 Verification rejections'],
            description: 'Incidents detected via error envelopes in the AEE audit trail and L8 verification rejections.',
          },
          triage: {
            count: allErrors.length,
            countLabel: 'incidents requiring triage',
            description: 'Errors logged and available for triage. Actual triage evidence (who reviewed, when, disposition) is not observed from system telemetry and must be recorded in your incident management system.',
          },
          containment: {
            count: securityAnomalies.length,
            countLabel: 'security anomalies with L3 policy gate enforcement',
            description: 'Security anomalies trigger L3 policy gate enforcement (automatic). Additional containment actions are organisational and not observed here.',
          },
          recovery: {
            count: allErrors.length,
            countLabel: 'incidents requiring recovery procedure',
            description: 'Errors for which recovery procedures are required. Actual recovery completion, post-incident review, and remediation must be documented separately.',
          },
        },
      }
    ]
  }
}

/**
 * Format CC8: Change Management
 */
function formatChangeManagement(traceData) {
  const { layerEvents } = traceData

  // L10 audit events
  const auditEvents = layerEvents.filter(e =>
    e.payload?.layer === 'L10' || e.intent?.includes('audit')
  )

  return {
    name: 'Change Management',
    controls: [
      {
        ...SOC2_CRITERIA.CC8_1,
        status: auditEvents.length > 0 ? 'compliant' : 'not_measured',
        findings: auditEvents.length > 0
          ? `${auditEvents.length} audit events recorded in period via AOCL L10 audit layer.`
          : 'No L10 audit events recorded in period. Change management audit trail not demonstrated.',
        evidence: auditEvents.slice(0, 10).map(e => ({
          id: e.id,
          timestamp: e.ts,
          type: 'audit_log',
          summary: 'Change recorded in audit trail'
        }))
      }
    ]
  }
}

/**
 * Format PI1: Processing Integrity
 */
function formatProcessingIntegrity(traceData, voltEvidence) {
  const { layerEvents, envelopes } = traceData

  // L0 normalization events
  const inputEvents = layerEvents.filter(e =>
    e.payload?.layer === 'L0' || e.intent?.includes('ingress')
  )

  // L9 assembly events
  const outputEvents = layerEvents.filter(e =>
    e.payload?.layer === 'L9' || e.intent?.includes('assemble')
  )

  // Processing events (L5, L7)
  const processingEvents = layerEvents.filter(e =>
    ['L5', 'L7'].includes(e.payload?.layer) ||
    e.intent?.includes('context') ||
    e.intent?.includes('delegate')
  )

  return {
    name: 'Processing Integrity',
    controls: [
      {
        ...SOC2_CRITERIA.PI1_1,
        // CRP-BE-6: Architectural claim without measurement → not_measured
        status: 'not_measured',
        findings: 'AOCL layer model provides processing integrity framework. Measurement requires VOLT evidence of layer execution coverage.',
        evidence: [{
          type: 'architecture',
          description: 'AOCL 11-layer processing pipeline with L3 policy gate and L8 verification'
        }]
      },
      {
        ...SOC2_CRITERIA.PI1_2,
        status: 'compliant',
        findings: `${inputEvents.length} input normalization events via L0 Ingress layer.`,
        evidence: inputEvents.slice(0, 10).map(e => ({
          id: e.id,
          timestamp: e.ts,
          type: 'input_control',
          status: e.payload?.status
        }))
      },
      {
        ...SOC2_CRITERIA.PI1_3,
        status: 'compliant',
        findings: `${processingEvents.length} processing events tracked via L5 Context and L7 Execute layers.`,
        evidence: processingEvents.slice(0, 10).map(e => ({
          id: e.id,
          timestamp: e.ts,
          layer: e.payload?.layer,
          status: e.payload?.status
        }))
      },
      {
        ...SOC2_CRITERIA.PI1_4,
        status: 'compliant',
        findings: `${outputEvents.length} output assembly events via L9 Assemble layer.`,
        evidence: outputEvents.slice(0, 10).map(e => ({
          id: e.id,
          timestamp: e.ts,
          type: 'output_control',
          status: e.payload?.status
        }))
      },
      ...(voltEvidence ? [{
        id: 'PI1.5',
        name: 'Evidence Bundle Verification',
        description: 'Hash-chained event traces verified via VOLT cryptographic evidence bundles.',
        category: 'Processing Integrity',
        status: voltEvidence.integrity_rate >= 95 ? 'compliant' : voltEvidence.integrity_rate >= 80 ? 'partial' : 'non-compliant',
        findings: `${voltEvidence.valid_count}/${voltEvidence.verified_sample} VOLT evidence bundles verified (${voltEvidence.integrity_rate}% integrity). ${voltEvidence.total_runs} total runs in period.`,
        evidence: [{
          type: 'volt_evidence',
          total_runs: voltEvidence.total_runs,
          verified_sample: voltEvidence.verified_sample,
          valid_count: voltEvidence.valid_count,
          integrity_rate: voltEvidence.integrity_rate
        }]
      }] : [])
    ]
  }
}

/**
 * Format A1: Availability
 */
function formatAvailability(traceData) {
  const { stats, layerEvents } = traceData

  // Calculate availability from trace data
  const totalRuns = layerEvents.filter(e => e.intent?.includes('run.complete')).length
  const successfulRuns = layerEvents.filter(e =>
    e.intent?.includes('run.complete') && e.payload?.success !== false
  ).length
  const availabilityRate = totalRuns > 0 ? (successfulRuns / totalRuns * 100).toFixed(2) : 100

  return {
    name: 'Availability',
    controls: [
      {
        ...SOC2_CRITERIA.A1_1,
        status: parseFloat(availabilityRate) >= 99 ? 'compliant' : 'partial',
        findings: `System availability: ${availabilityRate}% (${successfulRuns}/${totalRuns} successful runs).`,
        evidence: [{
          type: 'availability_metric',
          rate: availabilityRate,
          totalRuns,
          successfulRuns
        }]
      },
      {
        ...SOC2_CRITERIA.A1_2,
        status: 'requires_action',
        findings: 'Recovery objectives (RTO/RPO) require organisational definition. The Quox platform preserves evidence in VOLT hash chain, but RTO/RPO targets are set by your business continuity team.',
        evidence: [],
        recommendations: [
          'Define RTO (Recovery Time Objective) for each critical AI system',
          'Define RPO (Recovery Point Objective) — how much data loss is acceptable',
          'Document backup procedures for agent configurations, policies, and VOLT ledger',
          'Establish recovery runbook for each system',
        ],
      },
      {
        ...SOC2_CRITERIA.A1_3,
        status: 'requires_action',
        findings: 'Recovery testing requires periodic drills. The Quox platform does not automate DR testing — this is an operational responsibility.',
        evidence: [],
        recommendations: [
          'Schedule quarterly backup restoration drills',
          'Test failover to secondary infrastructure annually',
          'Document test results and remediation actions',
          'Review and update recovery procedures after each test',
        ],
      },
    ]
  }
}

/**
 * Generate findings from sections
 */
function generateFindings(sections) {
  const findings = []

  for (const [sectionId, section] of Object.entries(sections)) {
    for (const control of section.controls || []) {
      if (control.status !== 'compliant') {
        findings.push({
          controlId: control.id,
          severity: control.status === 'non-compliant' ? 'high' : 'medium',
          finding: control.findings,
          recommendation: `Review ${control.name} controls`
        })
      }
    }
  }

  return findings
}

/**
 * Generate recommendations from sections
 */
function generateRecommendations(sections) {
  const recommendations = []

  for (const section of Object.values(sections)) {
    for (const control of section.controls || []) {
      if (control.status === 'partial') {
        recommendations.push({
          controlId: control.id,
          priority: 'medium',
          recommendation: `Enhance ${control.name} to achieve full compliance`,
          currentStatus: control.findings
        })
      } else if (control.status === 'non-compliant') {
        recommendations.push({
          controlId: control.id,
          priority: 'high',
          recommendation: `Implement ${control.name} controls immediately`,
          currentStatus: control.findings
        })
      }
    }
  }

  return recommendations
}

export default {
  SOC2_CRITERIA,
  formatSOC2Report
}
