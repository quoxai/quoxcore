/**
 * EU AI Act Readiness Assessment Formatter
 *
 * Produces an EU AI Act readiness report — NOT a compliance or conformity declaration.
 *
 * The EU AI Act (Regulation (EU) 2024/1689) classifies AI systems by risk tier:
 * - Prohibited practices (Art. 5)
 * - High-risk systems (Arts. 6-15, 26-27) — Annex I products or Annex III use cases
 * - Limited risk / transparency obligations (Art. 50)
 * - General-purpose AI models (Arts. 51-56)
 *
 * This formatter assesses readiness against high-risk provider obligations (Arts. 9-15)
 * BUT first requires an applicability determination. Articles 9-15 only apply if the
 * system is classified as high-risk under Art. 6.
 *
 * Article corrections from prior version:
 * - Art. 62 is about SME/startup measures, NOT conformity assessment (conformity = Art. 43)
 * - Art. 72 is about post-market monitoring by providers, NOT enforcement
 * - Art. 12.2(a-d) specific subitems are for biometric systems, not generic high-risk
 * - VOLT integrity ≠ model accuracy (Art. 15.1)
 *
 * Generally applicable from 2 August 2026 (subject to legislative amendments).
 */

export const EU_AI_ACT_REQUIREMENTS = {
  // Applicability
  applicability: { id: 'APPLICABILITY', name: 'AI Act Classification', description: 'Determine the risk classification of this AI system under the EU AI Act.', category: 'Applicability' },

  // Art. 9 — Risk Management (high-risk providers)
  art9: { id: 'Art. 9', name: 'Risk Management System', description: 'A risk management system shall be established, implemented, documented and maintained throughout the entire lifecycle of a high-risk AI system.', category: 'High-Risk Provider Obligations' },

  // Art. 10 — Data Governance
  art10: { id: 'Art. 10', name: 'Data and Data Governance', description: 'High-risk AI systems which make use of techniques involving the training of AI models with data shall be developed on the basis of training, validation and testing data sets that meet quality criteria.', category: 'High-Risk Provider Obligations' },

  // Art. 11 — Technical Documentation
  art11: { id: 'Art. 11', name: 'Technical Documentation', description: 'The technical documentation shall be drawn up before the AI system is placed on the market or put into service.', category: 'High-Risk Provider Obligations' },

  // Art. 12 — Record-keeping / Logging
  art12: { id: 'Art. 12', name: 'Record-Keeping', description: 'High-risk AI systems shall technically allow for the automatic recording of events (logs) over the lifetime of the system.', category: 'High-Risk Provider Obligations' },

  // Art. 13 — Transparency and Information to Deployers
  art13: { id: 'Art. 13', name: 'Transparency and Provision of Information to Deployers', description: 'High-risk AI systems shall be designed and developed in such a way to ensure that their operation is sufficiently transparent to enable deployers to interpret the system\'s output and use it appropriately.', category: 'High-Risk Provider Obligations' },

  // Art. 14 — Human Oversight
  art14: { id: 'Art. 14', name: 'Human Oversight', description: 'High-risk AI systems shall be designed and developed in such a way, including with appropriate human-machine interface tools, that they can be effectively overseen by natural persons during the period in which they are in use.', category: 'High-Risk Provider Obligations' },

  // Art. 15 — Accuracy, Robustness and Cybersecurity
  art15: { id: 'Art. 15', name: 'Accuracy, Robustness and Cybersecurity', description: 'High-risk AI systems shall be designed and developed in such a way that they achieve an appropriate level of accuracy, robustness and cybersecurity, and perform consistently in those respects throughout their lifecycle.', category: 'High-Risk Provider Obligations' },

  // Art. 43 — Conformity Assessment (the actual conformity article)
  art43: { id: 'Art. 43', name: 'Conformity Assessment', description: 'Providers of high-risk AI systems shall follow the relevant conformity assessment procedure before placing the system on the market or putting it into service.', category: 'Conformity' },

  // Art. 72 — Post-Market Monitoring (corrected — not enforcement)
  art72: { id: 'Art. 72', name: 'Post-Market Monitoring by Providers', description: 'Providers shall establish and document a post-market monitoring system proportionate to the nature of the AI technologies and the risks of the high-risk AI system.', category: 'Post-Market' },
}

export function formatEUAIActReport(traceData, period, baseReport) {
  const { envelopes, layerEvents } = traceData
  const totalEnvelopes = envelopes?.length || 0
  const totalLayers = layerEvents?.length || 0
  // FMT-FIX: voltEvidence is attached to traceData by complianceExporter, not baseReport
  const voltEvidence = traceData?.voltEvidence || baseReport?.voltEvidence

  const sections = {
    applicability: formatApplicability(),
    riskManagement: formatRiskManagement(traceData),
    dataGovernance: formatDataGovernance(),
    technicalDocumentation: formatTechnicalDocumentation(),
    recordKeeping: formatRecordKeeping(traceData),
    transparency: formatTransparency(traceData, voltEvidence),
    humanOversight: formatHumanOversight(traceData),
    accuracyRobustness: formatAccuracyRobustness(traceData, voltEvidence),
    conformityAssessment: formatConformityAssessment(),
    postMarketMonitoring: formatPostMarketMonitoring(traceData),
  }

  // Conservative scoring: requires_action = 0, partial = 0.5
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
  const evidencedCount = allControls.filter(c => c.status === 'compliant' || c.status === 'partial').length

  let overallStatus = 'material_gaps'
  if (overallScore >= 90 && requiresActionCount === 0) overallStatus = 'substantially_aligned'
  else if (overallScore >= 60) overallStatus = 'partially_evidenced'
  else if (requiresActionCount > 0) overallStatus = 'action_required'

  return {
    ...baseReport,
    format: 'eu-ai-act',
    framework: 'EU AI Act',
    regulation: 'Regulation (EU) 2024/1689',
    reportType: 'ai_act_readiness_assessment',
    disclaimer: 'This is an EU AI Act readiness assessment based on system telemetry. It is NOT a conformity declaration or legal compliance determination. The EU AI Act requires an applicability determination (risk classification) before high-risk obligations apply. Articles 9–15 only apply to high-risk AI systems as classified under Art. 6. This assessment assumes potential high-risk classification for readiness purposes only. Seek legal advice for formal classification.',
    enforcementDate: '2026-08-02',
    enforcementDateNote: 'General application date. Subject to potential amendments. Annex II regulated-product high-risk systems from 2 August 2027.',
    overallScore,
    overallScoreNote: 'Internal readiness heuristic only — not a conformity metric. The EU AI Act does not use percentage-based scoring.',
    overallStatus,
    postureStatement: `${evidencedCount} of ${allControls.length} items have some system-level evidence. ${requiresActionCount} require organisational action. This assessment covers provider obligations for high-risk systems — applicability must be determined first.`,
    sections,
    voltEvidence: voltEvidence || null,
    operatorMatrix: generateOperatorMatrix(),
    gpaiObligations: generateGPAIObligations(),
    universalObligations: generateUniversalObligations(),
    qmsRequirements: generateQMSRequirements(),
    classificationMemoTemplate: generateClassificationMemoTemplate(),
  }
}

/**
 * FMT-V2-6: Operator matrix — which article obligations apply to which role
 * Providers place systems on the market; Deployers (formerly "users") use them;
 * Distributors make them available without modification.
 */
function generateOperatorMatrix() {
  return {
    note: 'The EU AI Act assigns different obligations to different operators in the AI value chain. Identify your role(s) — a single organisation may be both a provider and a deployer.',
    Provider: {
      definition: 'Entity that develops an AI system or has one developed, and places it on the EU market or puts it into service under its own name/trademark (Art.3(3)).',
      obligations: [
        'Art.9 — Establish a risk management system',
        'Art.10 — Data and data governance requirements',
        'Art.11 — Draw up and maintain technical documentation',
        'Art.12 — Automatic record-keeping (logs)',
        'Art.13 — Transparency and provision of information to deployers',
        'Art.14 — Design for human oversight',
        'Art.15 — Accuracy, robustness, and cybersecurity',
        'Art.16 — Quality Management System',
        'Art.17 — QMS specific documentation',
        'Art.43 — Conformity assessment procedure',
        'Art.47 — EU Declaration of Conformity',
        'Art.48 — CE marking',
        'Art.49 — Registration in EU database',
        'Art.72 — Post-market monitoring',
        'Art.73 — Report serious incidents',
      ],
    },
    Deployer: {
      definition: 'Entity using an AI system under its authority (formerly "user"). Excludes personal non-professional use (Art.3(4)).',
      obligations: [
        'Art.26(1) — Use AI system in accordance with provider instructions',
        'Art.26(2) — Assign human oversight to natural persons with necessary competence',
        'Art.26(3) — Ensure input data is relevant and representative',
        'Art.26(4) — Monitor operation and inform provider of serious incidents',
        'Art.26(5) — Keep automatically generated logs for at least 6 months',
        'Art.26(7) — Inform workers if using AI in workplace (employment context)',
        'Art.26(11) — Perform fundamental rights impact assessment (certain Annex III uses)',
        'Art.50 — Transparency obligations for certain AI systems',
      ],
    },
    Distributor: {
      definition: 'Entity in the supply chain, other than the provider or importer, that makes an AI system available on the EU market (Art.3(7)).',
      obligations: [
        'Art.24(1) — Verify the system has a CE marking and EU Declaration of Conformity',
        'Art.24(2) — Verify technical documentation and instructions for use accompany the system',
        'Art.24(3) — Ensure storage and transport conditions do not jeopardise compliance',
        'Art.24(4) — Take corrective action if the system is found non-compliant',
        'Art.24(5) — Cooperate with competent authorities',
      ],
    },
    Importer: {
      definition: 'Entity established in the EU that places an AI system from a third country on the EU market (Art.3(6)).',
      obligations: [
        'Art.23(1) — Verify provider compliance with Arts.16, 43, 47, 48',
        'Art.23(2) — Indicate name, trademark, and contact on the system or packaging',
        'Art.23(3) — Ensure storage and transport conditions do not jeopardise compliance',
        'Art.23(5) — Cooperate with competent authorities',
      ],
    },
  }
}

/**
 * FMT-V2-6: GPAI (General-Purpose AI) obligations under Art.52-56
 */
function generateGPAIObligations() {
  return {
    note: 'GPAI models (foundation models like Claude, GPT, Gemini) have specific obligations under Chapter V of the EU AI Act. If you USE a GPAI model, you are a downstream provider/deployer — the GPAI model provider bears these obligations. If you TRAIN or provide a GPAI model, you bear them directly.',
    standardGPAI: {
      applies: 'All GPAI model providers (Art.51)',
      obligations: [
        'Art.53(1)(a) — Draw up and maintain technical documentation per Annex XI',
        'Art.53(1)(b) — Provide information and documentation to downstream providers',
        'Art.53(1)(c) — Put in place a policy to comply with EU copyright law',
        'Art.53(1)(d) — Publish a sufficiently detailed summary of training data',
        'Art.54 — Appoint an authorised representative (for non-EU providers)',
      ],
    },
    systemicRiskGPAI: {
      applies: 'GPAI with systemic risk — presumed when cumulative training compute ≥ 10^25 FLOPs, or designated by Commission (Art.51(1)(a)/(2))',
      obligations: [
        'Art.55(1)(a) — Perform model evaluation with state-of-the-art protocols, including adversarial testing',
        'Art.55(1)(b) — Assess and mitigate possible systemic risks at Union level',
        'Art.55(1)(c) — Keep track of, document, and report to AI Office and competent authorities serious incidents',
        'Art.55(1)(d) — Ensure adequate cybersecurity protection for the model and physical infrastructure',
      ],
    },
    freeOpenSourceGPAI: {
      applies: 'GPAI models released under free and open-source licenses (without systemic risk)',
      note: 'Simpler obligations: Art.53(1)(c) copyright policy and Art.53(1)(d) training data summary only. Exempt from other Art.53 requirements. Systemic risk GPAI does not qualify for this exemption.',
    },
    transparencyAndCopyright: {
      art53d: 'Publishing training data summary — no strict format, but must be "sufficiently detailed" to help rights holders exercise their rights. The AI Office may provide template.',
      copyright: 'GPAI providers must have a policy to respect Art.4(3) of the CDSM Directive (2019/790) — opt-outs from text and data mining.',
    },
  }
}

/**
 * FMT-V2-6: Universal (non-high-risk) obligations — Art.4 + Art.50
 */
function generateUniversalObligations() {
  return {
    note: 'Some obligations apply to ALL AI systems regardless of risk classification. These often catch organisations by surprise because they apply even to minimal-risk internal tools.',
    'Art.4 AI Literacy': {
      applies: 'All providers and deployers of AI systems (Art.4)',
      requirement: 'Take measures to ensure, to your best extent, a sufficient level of AI literacy of staff and other persons dealing with the operation and use of AI systems on your behalf.',
      recommendations: [
        'Provide AI literacy training for all staff who interact with AI systems',
        'Tailor training to the technical knowledge, experience, and context of the users',
        'Keep records of training delivery (topics, attendees, dates)',
        'Update training as systems and regulations evolve',
      ],
      status: 'requires_action',
    },
    'Art.50 Transparency': {
      applies: 'Specific categories of AI systems regardless of risk classification',
      subsections: [
        { sub: 'Art.50(1)', rule: 'Chatbots and AI systems interacting with natural persons must inform those persons they are interacting with AI, unless obvious from context.' },
        { sub: 'Art.50(2)', rule: 'Providers of generative AI producing synthetic content (images, audio, video, text) must mark outputs as artificially generated in a machine-readable format.' },
        { sub: 'Art.50(3)', rule: 'Emotion recognition and biometric categorisation systems must inform subjects they are exposed to the system (with specific law enforcement exceptions).' },
        { sub: 'Art.50(4)', rule: 'Deep fake generators — deployers must label outputs as artificially generated or manipulated, with exceptions for artistic, creative, satirical, and fictional use.' },
      ],
      recommendations: [
        'Implement chatbot disclosure in your UI',
        'Add machine-readable markers (e.g. C2PA manifests) to AI-generated media',
        'Label deepfakes clearly in the user-facing output',
      ],
      status: 'requires_action',
    },
  }
}

/**
 * FMT-V2-6: Art.17 Quality Management System requirements
 */
function generateQMSRequirements() {
  return {
    note: 'Art.17 of the EU AI Act requires providers of high-risk AI systems to establish a Quality Management System with documented policies, procedures, and instructions. Can be integrated with existing ISO 9001 or similar QMS.',
    citation: 'Art.17 EU AI Act (Regulation 2024/1689)',
    mandatoryElements: [
      'Strategy for regulatory compliance (Art.17(1)(a))',
      'Techniques, procedures, and systematic actions for design, design control, and design verification (Art.17(1)(b))',
      'Techniques, procedures, and systematic actions for development, quality control, and quality assurance (Art.17(1)(c))',
      'Examination, test, and validation procedures before, during, and after development (Art.17(1)(d))',
      'Technical specifications to be applied, and references to harmonised standards (Art.17(1)(e))',
      'Systems and procedures for data management, including data acquisition, collection, analysis, labelling, storage, filtration, mining, aggregation, retention (Art.17(1)(f))',
      'Risk management system per Art.9 (Art.17(1)(g))',
      'Post-market monitoring system per Art.72 (Art.17(1)(h))',
      'Procedures related to reporting of serious incidents per Art.73 (Art.17(1)(i))',
      'Handling of communication with authorities, notified bodies, other operators, customers (Art.17(1)(j))',
      'Systems and procedures for record keeping of all documentation (Art.17(1)(k))',
      'Resource management including security-of-supply measures (Art.17(1)(l))',
      'Accountability framework — roles and responsibilities (Art.17(1)(m))',
    ],
    note2: 'Micro and small enterprises (Art.3(63)) may comply with these requirements in a simplified manner per Art.63.',
  }
}

/**
 * FMT-V2-6: Classification memo template — structured document recording the classification decision
 */
function generateClassificationMemoTemplate() {
  return {
    note: 'The EU AI Act does not mandate a specific classification memo format, but providers should document their classification decision to support Art.17 QMS and Art.72 post-market monitoring. Retain for 10 years per Art.18.',
    recommendedSections: [
      { section: 'System Name', content: '[AI system name and version]' },
      { section: 'Provider', content: '[Provider organisation and contact]' },
      { section: 'Intended Purpose', content: '[Specific intended purpose per Art.3(12) — includes use case, users, deployment context, data sources]' },
      { section: 'Classification', content: '[Prohibited / High-Risk (Annex I or III) / Limited Risk / Minimal Risk / GPAI Standard / GPAI Systemic Risk]' },
      { section: 'Classification Reasoning', content: '[Which articles and annexes lead to this classification. If Annex III, specify the sub-category (e.g. Annex III(4) employment). If high-risk, confirm not excluded by Art.6(3). Reference decision tree.]' },
      { section: 'Applicable Obligations', content: '[List of articles that apply based on classification and operator role(s)]' },
      { section: 'Conformity Assessment Route', content: '[If high-risk: self-assessment per Art.43 or notified body assessment. Justification.]' },
      { section: 'Risk Management Plan Reference', content: '[Link/reference to Art.9 risk management documentation]' },
      { section: 'Decision Date and Responsible Person', content: '[ISO date, named decision-maker, role/title]' },
      { section: 'Review Schedule', content: '[Reclassification triggers — material modification, intended purpose change, or scheduled periodic review]' },
    ],
    retention: '10 years from the date the AI system is placed on the market or put into service (Art.18(1))',
    recordKeeping: 'Available to national competent authorities on reasoned request (Art.18(2))',
  }
}

/**
 * Applicability — MUST be determined before anything else
 */
function formatApplicability() {
  return {
    name: 'Applicability and Risk Classification',
    note: 'The EU AI Act obligations depend on the risk classification of the AI system. High-risk obligations (Arts. 9–15) only apply if the system falls under Art. 6: either as an Annex I safety component/product, or an Annex III listed use case (employment, education, law enforcement, migration, creditworthiness, etc.).',
    controls: [
      {
        ...EU_AI_ACT_REQUIREMENTS.applicability,
        status: 'requires_action',
        findings: 'Before assessing high-risk obligations, determine: (1) Is this system an AI system as defined in Art. 3? (2) Is the provider/deployer established in or serving the EU market? (3) Does the system fall under prohibited practices (Art. 5)? (4) Is it high-risk under Art. 6 (Annex I product or Annex III use case)? (5) What is the provider/deployer role? These are legal determinations that cannot be made from system telemetry.',
        action_required: 'Conduct formal AI Act classification with legal counsel. Document: system definition, risk tier, provider/deployer role, applicable articles. If not high-risk, most of this assessment does not apply.',
        evidence: []
      },
    ]
  }
}

/**
 * Art. 9 — Risk Management
 */
function formatRiskManagement(traceData) {
  const l3Events = countLayerEvents(traceData, 'L3')
  const l8Events = countLayerEvents(traceData, 'L8')

  return {
    name: 'Risk Management System (Art. 9)',
    note: 'Art. 9 requires a documented, continuously maintained risk management system throughout the AI system lifecycle. This includes identifying risks, estimating risks, evaluating risks from post-market data, and adopting appropriate measures.',
    controls: [
      {
        id: '9.1',
        name: 'Documented risk management system',
        status: 'requires_action',
        findings: 'Art. 9(1) requires a risk management system that is established, implemented, documented, and maintained throughout the entire lifecycle. System telemetry (L3 policy gate, L8 verification) provides risk mitigation mechanisms but is not a documented risk management system.',
        action_required: 'Document a risk management system covering: risk identification methodology, risk assessment criteria, risk treatment measures, monitoring and review process. Update throughout system lifecycle.',
        evidence: [{ type: 'supporting', l3_evaluations: l3Events, l8_verifications: l8Events, note: 'AOCL layers provide risk mitigation mechanisms — supporting evidence for Art. 9(2)(d)' }]
      },
      {
        id: '9.2(a-c)',
        name: 'Risk identification, estimation, and evaluation',
        status: 'requires_action',
        findings: 'Art. 9(2) requires identification and analysis of known and foreseeable risks, estimation and evaluation of emerging risks, and evaluation based on post-market monitoring data. These are analytical processes requiring human judgment.',
        action_required: 'Conduct and document risk analysis. Identify foreseeable risks specific to this AI system and its intended purpose.',
        evidence: []
      },
      {
        id: '9.2(d)',
        name: 'Risk management measures',
        status: l3Events > 0 || l8Events > 0 ? 'partial' : 'requires_action',
        findings: l3Events > 0
          ? `AOCL L3 Policy Gate (${l3Events} evaluations) and L8 Response Verification (${l8Events} checks) provide technical risk management measures. Art. 9(2)(d) also requires that measures are appropriate to eliminate or reduce risks as far as possible.`
          : 'No AOCL risk management evidence in period.',
        evidence: [{ type: 'risk_measures', l3: l3Events, l8: l8Events }]
      },
    ]
  }
}

/**
 * Art. 10 — Data Governance
 */
function formatDataGovernance() {
  return {
    name: 'Data and Data Governance (Art. 10)',
    controls: [
      {
        id: '10.2',
        name: 'Training, validation and testing data quality',
        status: 'requires_action',
        findings: 'Art. 10 requires that training, validation, and testing datasets meet quality criteria: relevant, sufficiently representative, free from errors, complete. For AI agent orchestration systems, this applies to any fine-tuning, prompt engineering datasets, or evaluation benchmarks used.',
        action_required: 'Document data governance practices for any training/fine-tuning data. If using third-party foundation models, document the provider\'s data governance commitments.',
        evidence: []
      },
    ]
  }
}

/**
 * Art. 11 — Technical Documentation
 */
function formatTechnicalDocumentation() {
  return {
    name: 'Technical Documentation (Art. 11)',
    controls: [
      {
        id: '11.1',
        name: 'Technical documentation drawn up before market placement',
        status: 'requires_action',
        findings: 'Art. 11 requires comprehensive technical documentation drawn up before the system is placed on the market. This must include: general description, detailed description of elements and development process, monitoring and control, and information on functioning.',
        action_required: 'Produce technical documentation per Annex IV requirements. Include: system description, design specifications, development methodology, validation and testing procedures, risk management documentation.',
        evidence: []
      },
    ]
  }
}

/**
 * Art. 12 — Record-Keeping (generic high-risk, NOT biometric-specific subitems)
 */
function formatRecordKeeping(traceData) {
  const totalEnvelopes = traceData?.envelopes?.length || 0
  const totalLayers = traceData?.layerEvents?.length || 0

  return {
    name: 'Record-Keeping (Art. 12)',
    note: 'Art. 12(1) requires automatic logging capability. The specific subitems in Art. 12(2-3) have additional requirements for particular high-risk categories (e.g. biometric systems). This assessment covers the general logging obligation.',
    controls: [
      {
        id: '12.1',
        name: 'Automatic recording of events (logs)',
        status: totalEnvelopes > 0 ? 'partial' : 'not_measured',
        findings: totalEnvelopes > 0
          ? `AEE protocol automatically records ${totalEnvelopes} events with ${totalLayers} AOCL layer events. Each event includes: identity (from/to), intent, timestamp, correlation ID, and payload. Art. 12 also requires that logging is designed to enable tracing of system functioning — AOCL layer events and VOLT hash chains support this.`
          : 'No logging evidence in period.',
        action_required: 'Verify logging covers the full system lifecycle. Document log retention policy. Ensure logs enable traceability of system functioning throughout the period of use.',
        evidence: [{ type: 'logging', envelopes: totalEnvelopes, layer_events: totalLayers }]
      },
    ]
  }
}

/**
 * Art. 13 — Transparency (information to deployers, not VOLT integrity)
 */
function formatTransparency(traceData, voltEvidence) {
  return {
    name: 'Transparency and Information to Deployers (Art. 13)',
    note: 'Art. 13 requires providing deployers with: intended purpose, level of accuracy/robustness/cybersecurity metrics, known limitations, input data specifications, and human oversight measures.',
    controls: [
      {
        id: '13.1',
        name: 'Sufficient transparency for deployer interpretation',
        status: 'requires_action',
        findings: 'Art. 13(1) requires the system to be designed for sufficient transparency so deployers can interpret output and use it appropriately. AOCL layer visualisation supports this, but deployer-facing documentation (instructions for use) must also be provided.',
        action_required: 'Produce instructions for use covering: intended purpose, capabilities, limitations, performance characteristics, input specifications, human oversight requirements.',
        evidence: [{ type: 'supporting', description: 'AOCL layer stack provides processing transparency' }]
      },
      {
        id: '13.3(b)',
        name: 'Accuracy, robustness and cybersecurity metrics',
        status: 'requires_action',
        findings: 'Art. 13(3)(b)(ii) requires declaring the level of accuracy, robustness, and cybersecurity with respect to which the system has been tested and validated. This means model performance metrics (accuracy, precision, recall, error rates) — not VOLT hash-chain integrity. VOLT provides data integrity/tamper-evidence, which is valuable for traceability but is not a model accuracy metric.',
        action_required: 'Document and declare: model accuracy metrics, robustness testing results (adversarial inputs, distribution shift), and cybersecurity assessment results.',
        evidence: voltEvidence ? [{ type: 'supporting', note: 'VOLT provides data integrity verification — supporting evidence for traceability, not a substitute for model accuracy metrics', integrity_rate: voltEvidence.integrity_rate }] : []
      },
    ]
  }
}

/**
 * Art. 14 — Human Oversight
 */
function formatHumanOversight(traceData) {
  const hitlCount = countHITLEvents(traceData)

  return {
    name: 'Human Oversight (Art. 14)',
    note: 'Art. 14 requires that high-risk systems can be effectively overseen by natural persons. This includes: understanding capabilities and limitations, awareness of automation bias, ability to interpret output, ability to override or not use the system, and ability to interrupt through a stop mechanism.',
    controls: [
      {
        id: '14.1-2',
        name: 'Design for effective human oversight',
        status: 'requires_action',
        findings: 'Art. 14(1-2) requires the system to be designed with appropriate human-machine interface tools for oversight. This requires documented human oversight design, role assignment, and operational procedures — not just the existence of an inbox or kill switch.',
        action_required: 'Document human oversight design: who oversees, how, when HITL is required, training requirements for overseers, escalation procedures.',
        evidence: []
      },
      {
        id: '14.4(a)',
        name: 'Override capability — ability to not use or disregard output',
        status: hitlCount > 0 ? 'partial' : 'requires_action',
        findings: hitlCount > 0
          ? `HITL inbox provides override capability (${hitlCount} human-in-the-loop events recorded). Art. 14(4)(a) also requires that overseers are actually trained and operationally able to exercise override.`
          : 'No HITL events recorded. Override capability may exist but has not been demonstrated in this period.',
        action_required: 'Document and test override procedures. Ensure overseers are trained. Verify override is operationally accessible.',
        evidence: [{ type: 'hitl', events: hitlCount }]
      },
      {
        id: '14.4(c)',
        name: 'Stop/interrupt mechanism',
        status: 'partial',
        findings: 'DEFCON safety system provides graduated intervention levels up to full system halt. Art. 14(4)(c) requires the ability to intervene or interrupt through a stop button or similar procedure. The mechanism exists; documented procedures for its use in human oversight are required.',
        action_required: 'Document stop/interrupt procedures. Define when and how the stop mechanism is activated. Test the mechanism.',
        evidence: [{ type: 'supporting', description: 'DEFCON 5-tier safety system with kill switch' }]
      },
    ]
  }
}

/**
 * Art. 15 — Accuracy, Robustness, Cybersecurity
 */
function formatAccuracyRobustness(traceData, voltEvidence) {
  const l0Events = countLayerEvents(traceData, 'L0')
  const l3Events = countLayerEvents(traceData, 'L3')
  const l8Events = countLayerEvents(traceData, 'L8')

  return {
    name: 'Accuracy, Robustness and Cybersecurity (Art. 15)',
    note: 'Art. 15 requires appropriate levels of accuracy, robustness, and cybersecurity throughout the lifecycle. Accuracy means model performance metrics — not data integrity. Robustness means resilience to errors and adversarial inputs. Cybersecurity means protection against attacks.',
    controls: [
      {
        id: '15.1',
        name: 'Appropriate level of accuracy',
        status: 'requires_action',
        findings: 'Art. 15(1) requires accuracy levels to be declared in the instructions for use. "Accuracy" in this context means model performance (precision, recall, error rates) — not VOLT hash-chain integrity. VOLT provides tamper-evidence for audit trails, which supports traceability but is a different property.',
        action_required: 'Define and measure model accuracy metrics appropriate to the intended purpose. Declare accuracy levels in instructions for use. Establish accuracy monitoring for drift detection.',
        evidence: voltEvidence ? [{ type: 'supporting', note: 'VOLT hash chains provide data integrity/tamper-evidence — supports traceability requirement, not accuracy measurement', integrity_rate: voltEvidence.integrity_rate }] : []
      },
      {
        id: '15.4',
        name: 'Resilience against errors, faults or inconsistencies',
        status: l0Events > 0 || l8Events > 0 ? 'partial' : 'not_measured',
        findings: l0Events > 0
          ? `L0 input validation (${l0Events} events) and L8 response verification (${l8Events} events) provide error resilience mechanisms. Art. 15(4) also requires resilience against attempts by unauthorised third parties to alter use or performance (adversarial robustness).`
          : 'No input validation or response verification events in period.',
        action_required: 'Conduct adversarial robustness testing. Document resilience measures against faults, errors, and adversarial inputs.',
        evidence: [{ type: 'resilience', l0: l0Events, l8: l8Events }]
      },
      {
        id: '15.5',
        name: 'Appropriate level of cybersecurity',
        status: l3Events > 0 ? 'partial' : 'requires_action',
        findings: l3Events > 0
          ? `AOCL L3 Policy Gate (${l3Events} evaluations), AES-256-GCM encryption, RBAC access controls provide cybersecurity measures. Art. 15(5) requires protection against attempts to exploit vulnerabilities — a comprehensive cybersecurity assessment is needed.`
          : 'No L3 policy enforcement evidence in period.',
        action_required: 'Conduct cybersecurity assessment. Document: threat model, vulnerability management, access controls, incident response. Test against AI-specific attacks (prompt injection, data poisoning, model extraction).',
        evidence: [{ type: 'security_measures', l3: l3Events, encryption: 'AES-256-GCM', access_control: 'RBAC' }]
      },
    ]
  }
}

/**
 * Art. 43 — Conformity Assessment (corrected from Art. 62)
 */
function formatConformityAssessment() {
  return {
    name: 'Conformity Assessment (Art. 43)',
    note: 'Art. 43 requires providers to follow the relevant conformity assessment procedure before placing a high-risk system on the market. The procedure depends on whether the system is covered by Annex I legislation or falls under Annex III.',
    controls: [
      {
        id: '43.1',
        name: 'Conformity assessment procedure',
        status: 'requires_action',
        findings: 'Conformity assessment requires: compliance with all Art. 8-15 requirements, quality management system (Art. 17), technical documentation (Art. 11), and either internal control (Annex VI) or third-party assessment (Annex VII) depending on system classification.',
        action_required: 'Determine the applicable conformity assessment procedure based on the system classification. Prepare documentation. If Annex III (standalone): internal control per Annex VI may suffice. If Annex I (product): follow the applicable product legislation procedure.',
        evidence: []
      },
    ]
  }
}

/**
 * Art. 72 — Post-Market Monitoring (corrected — not enforcement)
 */
function formatPostMarketMonitoring(traceData) {
  const totalEnvelopes = traceData?.envelopes?.length || 0

  return {
    name: 'Post-Market Monitoring by Providers (Art. 72)',
    note: 'Art. 72 requires providers to establish a post-market monitoring system proportionate to the nature and risks of the AI system. This is a provider obligation, not an enforcement mechanism.',
    controls: [
      {
        id: '72.1',
        name: 'Post-market monitoring system',
        status: totalEnvelopes > 0 ? 'partial' : 'requires_action',
        findings: totalEnvelopes > 0
          ? `AEE+AOCL+VOLT+WARD protocol stack provides comprehensive post-market monitoring data (${totalEnvelopes} events). Art. 72 also requires a documented monitoring plan and active collection of data relevant to compliance throughout the system lifecycle.`
          : 'No monitoring data in period.',
        action_required: 'Document a post-market monitoring plan. Define what data is collected, how it is analysed, and how it feeds back into the risk management system (Art. 9).',
        evidence: [{ type: 'monitoring_capability', events: totalEnvelopes }]
      },
    ]
  }
}

// --- Helpers ---

function countLayerEvents(traceData, layerId) {
  if (!traceData?.layerEvents) return 0
  return traceData.layerEvents.filter(le => (le.payload?.layer || le.layer) === layerId).length
}

function countHITLEvents(traceData) {
  if (!traceData?.envelopes) return 0
  return traceData.envelopes.filter(e =>
    e.intent?.includes('approval') || e.type === 'approval'
  ).length
}

export default {
  EU_AI_ACT_REQUIREMENTS,
  formatEUAIActReport
}
