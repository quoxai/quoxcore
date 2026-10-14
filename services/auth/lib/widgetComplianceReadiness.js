/**
 * QCX-10a — Pure compliance-readiness checker.
 *
 * Returns a flat checklist of compliance gates against a widget's current
 * state. Each check has {id, passed, severity, message, fix?}. The
 * `ready` boolean is true when no `blocker`-severity check has failed —
 * warnings are surfaced for admin attention but don't block publish.
 */

// ESM module — auth uses "type": "module".

const NA = (id, message) => ({ id, passed: true, severity: 'info', message });
const PASS = (id, message) => ({ id, passed: true, severity: 'blocker', message });
const FAIL_BLOCK = (id, message, fix) => ({ id, passed: false, severity: 'blocker', message, fix });
const FAIL_WARN = (id, message, fix) => ({ id, passed: false, severity: 'warning', message, fix });

export function evaluateComplianceReadiness(widget, embedConfig, classification) {
  const cfg = embedConfig || {};
  const cls = classification || {};
  const tier = widget?.risk_tier || cls.tier || 'limited_risk';
  const inputs = cls.inputs || {};
  const requiresHipaa = cls.requires_hipaa === true;
  const checks = [];

  // 1) Prohibited tier — instant blocker.
  if (tier === 'prohibited') {
    checks.push(FAIL_BLOCK(
      'tier_prohibited',
      'Widget is classified as prohibited under EU AI Act Art.5 — cannot be deployed.',
      'Remove the prohibited use-case flag(s) (social scoring / subliminal manipulation) and re-classify.',
    ));
  } else {
    checks.push(PASS('tier_prohibited', `Risk tier is ${tier}, not prohibited.`));
  }

  // 2) Privacy policy URL — required for all tiers (Art.13/14 GDPR).
  if (typeof cfg.privacy_policy_url === 'string' && cfg.privacy_policy_url.length > 0) {
    checks.push(PASS('privacy_policy_url', 'Privacy policy URL is set.'));
  } else {
    checks.push(FAIL_BLOCK(
      'privacy_policy_url',
      'Privacy policy URL is required for visitor transparency (GDPR Art.13/14).',
      'Set embed_config_json.privacy_policy_url on the widget settings tab.',
    ));
  }

  // 3) DPIA — at least one classification input flag must be set on
  //    high-risk tiers, evidencing the admin actually answered the wizard.
  if (tier === 'high_risk_annex_iii' || tier === 'high_risk_annex_i') {
    const anyInputSet = Object.values(inputs).some(v => v === true);
    if (anyInputSet) {
      checks.push(PASS('dpia_completed', 'DPIA classification inputs recorded.'));
    } else {
      checks.push(FAIL_BLOCK(
        'dpia_completed',
        'High-risk widget must have a completed DPIA (GDPR Art.35).',
        'Open the Compliance tab and check the applicable DPIA flags.',
      ));
    }
  } else {
    checks.push(NA('dpia_completed', 'Not required for this tier.'));
  }

  // 4) Consent banner — required for high-risk + when PHI is processed.
  if (tier === 'high_risk_annex_iii' || tier === 'high_risk_annex_i' || requiresHipaa) {
    if (cfg.consent_required === true) {
      checks.push(PASS('consent_required', 'Pre-message consent banner is enabled.'));
    } else {
      checks.push(FAIL_BLOCK(
        'consent_required',
        'High-risk widgets must capture explicit visitor consent before any message is processed.',
        'Set embed_config_json.consent_required = true and write a consent_text.',
      ));
    }
  } else {
    checks.push(NA('consent_required', 'Optional for this tier.'));
  }

  // 5) HIPAA BAA — required when PHI flag is set.
  if (requiresHipaa) {
    if (cfg.baa_acknowledged === true) {
      checks.push(PASS('baa_acknowledged', 'BAA acknowledged.'));
    } else {
      checks.push(FAIL_BLOCK(
        'baa_acknowledged',
        'PHI processing requires a Business Associate Agreement (BAA) on file.',
        'Sign the BAA template and set embed_config_json.baa_acknowledged = true.',
      ));
    }
  } else {
    checks.push(NA('baa_acknowledged', 'Not required (no PHI processing).'));
  }

  // 6) Retention — warning when null: no org default exists, so nothing is
  //    pruned automatically. Not a blocker; surfaced as a warning.
  if (typeof widget?.retention_days_override === 'number' && widget.retention_days_override > 0) {
    checks.push(PASS('retention_configured', `Retention set to ${widget.retention_days_override} days.`));
  } else {
    checks.push(FAIL_WARN(
      'retention_configured',
      'No retention period set: conversations are kept until deleted.',
      `Set a retention period on the Compliance tab: /quoxchat/${widget?.id || ':widgetId'}?tab=compliance`,
    ));
  }

  // 7) DPA URL — warning when missing (some jurisdictions only).
  if (typeof cfg.dpa_url === 'string' && cfg.dpa_url.length > 0) {
    checks.push(PASS('dpa_url', 'DPA URL is set.'));
  } else {
    checks.push(FAIL_WARN(
      'dpa_url',
      'No Data Processing Addendum URL set; recommended for B2B widgets.',
      'Set embed_config_json.dpa_url to your operator’s DPA template.',
    ));
  }

  const ready = !checks.some(c => c.severity === 'blocker' && c.passed === false);
  return { ready, checks };
}
