/**
 * GOV-6: Compliance Policy Evaluator
 *
 * PII detection, data residency enforcement, and compliance policy evaluation.
 * Scans query text for PII patterns, enriches context, evaluates compliance-category
 * policies from the store.
 */

const { listPolicies } = require('./policyStore.js');
const { evaluateCondition } = require('./conditionEvaluator.js');

// ============================================================
// PII Detection
// ============================================================

const PII_TYPES = ['ssn', 'email', 'phone', 'credit_card', 'ip_address', 'api_key'];

const PII_PATTERNS = {
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
  email: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}\b/,
  phone: /(?:\(\d{3}\)\s?|\b\d{3}[-.])\d{3}[-.]?\d{4}\b/,
  credit_card: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/,
  ip_address: /\b(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/,
  api_key: /\b(?:sk-[a-zA-Z0-9_-]{20,}|sk-ant-[a-zA-Z0-9_-]{10,}|Bearer\s+[a-zA-Z0-9_-]{20,})\b/,
};

/**
 * Scan text for PII patterns.
 * @param {string} text
 * @returns {{ hasPII: boolean, types: string[], matches: number }}
 */
function detectPII(text) {
  if (!text || typeof text !== 'string') {
    return { hasPII: false, types: [], matches: 0 };
  }

  const found = [];
  let totalMatches = 0;

  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    const matches = text.match(new RegExp(pattern.source, pattern.flags + 'g'));
    if (matches && matches.length > 0) {
      found.push(type);
      totalMatches += matches.length;
    }
  }

  return {
    hasPII: found.length > 0,
    types: found,
    matches: totalMatches,
  };
}

// ============================================================
// Context Builder
// ============================================================

/**
 * Build a compliance-enriched context for policy evaluation.
 * Includes PII detection results, provider info, and agent context.
 */
function buildComplianceContext(query, context = {}) {
  const pii = detectPII(query);

  return {
    'query.text': query || '',
    'agent.id': context.agent || 'quox',
    'data.hasPII': pii.hasPII,
    'data.piiTypes': pii.types,
    'data.piiCount': pii.matches,
    'provider.name': context.provider || '',
    'provider.region': context.region || '',
    'correlation.id': context.corr || '',
  };
}

// ============================================================
// Compliance Policy Evaluator
// ============================================================

/**
 * Evaluate compliance-category policies from the store against a query.
 *
 * @param {object} db - SQLite database handle
 * @param {string} orgId - Organization ID
 * @param {string} query - User query text
 * @param {object} context - { agent, provider, region, corr }
 * @returns {{ denied: boolean, denyReason: string|null, requiresApproval: boolean, approvalReason: string|null, warnings: string[], matchedPolicies: Array }}
 */
function evaluateCompliancePolicies(db, orgId, query, context = {}) {
  const result = {
    denied: false,
    denyReason: null,
    requiresApproval: false,
    approvalReason: null,
    warnings: [],
    matchedPolicies: [],
    error: null,
  };

  if (!db) {
    result.error = 'no_database_handle';
    return result;
  }

  try {
    const policies = listPolicies(db, { org_id: orgId, category: 'compliance', enabled: true });
    if (!policies.data || policies.data.length === 0) return result;

    const ctx = buildComplianceContext(query, context);

    for (const policy of policies.data) {
      if (!policy.conditions) continue;

      let matches = false;
      try {
        matches = evaluateCondition(policy.conditions, ctx);
      } catch (condErr) {
        // A single bad policy shouldn't crash all policy evaluation — log and skip
        console.warn(`[CompliancePolicy] Condition eval failed for ${policy.name}:`, condErr.message);
        continue;
      }

      if (!matches) continue;

      const matched = {
        id: policy.id,
        name: policy.name,
        effect: policy.effect,
        reason: policy.reason,
        frameworks: policy.framework_mapping || [],
      };
      result.matchedPolicies.push(matched);

      if (policy.effect === 'deny' && !result.denied) {
        result.denied = true;
        result.denyReason = policy.reason || `Denied by compliance policy: ${policy.name}`;
      }

      if (policy.effect === 'require_approval' && !result.requiresApproval && !result.denied) {
        result.requiresApproval = true;
        result.approvalReason = policy.reason || `Requires approval per compliance policy: ${policy.name}`;
      }

      if (policy.effect === 'log_only') {
        result.warnings.push(policy.reason || `Compliance policy flagged: ${policy.name}`);
      }
    }
  } catch (err) {
    // DB-level error — report it so the caller can fail-closed
    result.error = err.message || String(err);
    console.error('[CompliancePolicy] Evaluation failed:', result.error);
  }

  return result;
}

module.exports = {
  detectPII,
  buildComplianceContext,
  evaluateCompliancePolicies,
  PII_TYPES,
  PII_PATTERNS,
};
