/**
 * QCX-6d — Pure widget risk classifier.
 *
 * Maps a widget's DPIA-wizard flags onto the EU AI Act 7-tier framework
 * using the same decision tree the AUD-UX RiskClassificationWizard
 * implements interactively. Pure function: no DB, no React, fully unit
 * tested in services/auth/tests/widget-risk-classifier.test.js.
 *
 * Most-restrictive tier wins when multiple flags fire — admins cannot
 * accidentally downgrade a high-risk widget by also ticking "FAQ only".
 *
 * Inputs (all booleans, all optional):
 *   social_scoring_public_auth      → prohibited
 *   subliminal_manipulation         → prohibited
 *   processes_phi                   → high_risk_annex_iii (HIPAA overlay)
 *   processes_biometrics            → high_risk_annex_iii
 *   processes_employment_decisions  → high_risk_annex_iii
 *   processes_credit_decisions      → high_risk_annex_iii
 *   affects_education_access        → high_risk_annex_iii
 *   safety_component_regulated_product → high_risk_annex_i
 *   no_pii + no_decisions + faq_only → minimal_risk
 *   (default for chat assistants)   → limited_risk (Art.52)
 *
 * Outputs:
 *   {
 *     tier:           one of RISK_TIERS,
 *     reasons:        string[],          why this tier
 *     obligations:    string[],          what the operator must do
 *     requires_hipaa: boolean,
 *     requires_dpia:  boolean,
 *   }
 */

// ESM module — auth service uses "type": "module".

export const RISK_TIERS = [
  'prohibited',
  'high_risk_annex_i',
  'high_risk_annex_iii',
  'gpai_systemic',
  'gpai_standard',
  'limited_risk',
  'minimal_risk',
];

const TIER_META = {
  prohibited:           { label: 'Prohibited',                color: '#ef4444', severity: 4 },
  high_risk_annex_i:    { label: 'High-Risk (Annex I)',       color: '#ff6b35', severity: 3 },
  high_risk_annex_iii:  { label: 'High-Risk (Annex III)',     color: '#ff6b35', severity: 3 },
  gpai_systemic:        { label: 'GPAI — Systemic Risk',      color: '#f59e0b', severity: 3 },
  gpai_standard:        { label: 'GPAI Model',                color: '#00e5ff', severity: 2 },
  limited_risk:         { label: 'Limited Risk',              color: '#00e5ff', severity: 1 },
  minimal_risk:         { label: 'Minimal Risk',              color: '#30ff90', severity: 0 },
};

const OBLIGATIONS = {
  prohibited: [
    'Use case is prohibited under EU AI Act Art.5 — widget cannot be deployed in the EU.',
  ],
  high_risk_annex_i: [
    'Conformity assessment under sectoral product law (Annex I) before placing on the market.',
    'Risk management system, technical documentation, post-market monitoring.',
    'DPIA (GDPR Art.35) required.',
  ],
  high_risk_annex_iii: [
    'Risk management system + quality management system.',
    'Logging + record-keeping + human oversight.',
    'DPIA (GDPR Art.35) required before deployment.',
    'Conformity assessment + CE marking.',
  ],
  gpai_systemic: [
    'Model evaluation + adversarial testing + serious-incident reporting.',
    'Cybersecurity protections at the system level.',
  ],
  gpai_standard: [
    'Technical documentation + downstream-deployer instructions.',
    'Copyright training-data summary.',
  ],
  limited_risk: [
    'Article 52 transparency obligation: visitor must be informed they are interacting with an AI system.',
    'Output must be marked as AI-generated when the visitor reasonably expects human contact.',
  ],
  minimal_risk: [
    'No mandatory obligations under the EU AI Act.',
    'Voluntary code of conduct encouraged.',
  ],
};

function _truthy(v) { return v === true; }

export function classifyWidgetRisk(input) {
  const cfg = (input && typeof input === 'object') ? input : {};
  const reasons = [];

  // 1) Prohibited beats everything else.
  if (_truthy(cfg.social_scoring_public_auth)) reasons.push('Social scoring of natural persons by public authority (Art.5).');
  if (_truthy(cfg.subliminal_manipulation))    reasons.push('Subliminal techniques causing harm (Art.5).');
  if (reasons.length > 0) {
    return _result('prohibited', reasons);
  }

  // 2) High-risk Annex I — safety component of regulated product (rare for chat).
  if (_truthy(cfg.safety_component_regulated_product)) {
    return _result('high_risk_annex_i', [
      'Safety component of a product covered by Annex I sectoral law.',
    ]);
  }

  // 3) High-risk Annex III triggers.
  if (_truthy(cfg.processes_phi))                  reasons.push('Processes Protected Health Information (PHI).');
  if (_truthy(cfg.processes_biometrics))           reasons.push('Processes biometric data.');
  if (_truthy(cfg.processes_employment_decisions)) reasons.push('Influences employment decisions.');
  if (_truthy(cfg.processes_credit_decisions))     reasons.push('Influences credit / creditworthiness decisions.');
  if (_truthy(cfg.affects_education_access))       reasons.push('Affects access to education / vocational training.');
  if (reasons.length > 0) {
    return _result('high_risk_annex_iii', reasons);
  }

  // 4) Minimal-risk opt-in (must satisfy ALL three flags).
  if (_truthy(cfg.no_pii) && _truthy(cfg.no_decisions) && _truthy(cfg.faq_only)) {
    return _result('minimal_risk', [
      'No PII processing, no automated decisions, FAQ-only scope.',
    ]);
  }

  // 5) Default for any chat assistant — Art.52 transparency obligations.
  return _result('limited_risk', [
    'Default tier for an AI chat assistant — Article 52 transparency obligations apply.',
  ]);
}

function _result(tier, reasons) {
  const requires_hipaa = tier === 'high_risk_annex_iii' && reasons.some(r => /phi|health/i.test(r));
  const requires_dpia = tier === 'high_risk_annex_iii' || tier === 'high_risk_annex_i';
  return {
    tier,
    reasons,
    obligations: OBLIGATIONS[tier].slice(),
    requires_hipaa,
    requires_dpia,
  };
}

export function riskTierMeta(tier) {
  return TIER_META[tier] || TIER_META.limited_risk;
}
