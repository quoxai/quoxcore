/**
 * GOV-E-2: Safety Policy Evaluator
 *
 * Mirrors compliancePolicyEvaluator.js but queries `category: 'safety'`.
 * Safety policies cover SQL injection, shell command injection, credential
 * exposure attempts, and other threat patterns — distinct from compliance
 * (PII, data residency, framework obligations).
 *
 * Key design decision: on DB/evaluation errors, return a distinct `error` field
 * rather than silently failing open. The chat handler must fail-closed on error
 * (return 500) rather than proceed with unknown safety state.
 */

const { listPolicies } = require('./policyStore.js');
const { evaluateCondition } = require('./conditionEvaluator.js');

// ============================================================
// Safety Heuristics
// ============================================================

// SQL injection signals (simple regex heuristics — policies can refine)
const SQL_INJECTION_PATTERNS = [
  /(?:'|")\s*(?:;|--|\bor\b|\band\b)\s*/i,
  /\b(?:union\s+select|drop\s+table|delete\s+from|insert\s+into|update\s+\w+\s+set)\b/i,
  /--\s*$/m,
  /;\s*(?:drop|delete|truncate|alter)\s+/i,
];

// Shell command injection signals
const SHELL_INJECTION_PATTERNS = [
  /\brm\s+-rf\s+\/[^\s]*/,
  /:\(\)\s*\{\s*:\s*\|:\s*&\s*\}\s*;\s*:/, // fork bomb
  /\b(?:wget|curl)\s+[^\s]+\s*\|\s*(?:sh|bash)/,
  /\b(?:nc|netcat)\s+-[le]/,
  /\b(?:chmod|chown)\s+[0-7]{3,4}\s+\/(?:etc|bin|usr|var|boot)/,
];

function hasSqlInjection(text) {
  if (!text || typeof text !== 'string') return false;
  return SQL_INJECTION_PATTERNS.some(p => p.test(text));
}

function hasShellInjection(text) {
  if (!text || typeof text !== 'string') return false;
  return SHELL_INJECTION_PATTERNS.some(p => p.test(text));
}

// ============================================================
// Context Builder
// ============================================================

/**
 * Build a safety-enriched context for policy evaluation.
 */
function buildSafetyContext(query, context = {}) {
  return {
    'query.text': query || '',
    'agent.id': context.agent || 'quox',
    'safety.sqlInjection': hasSqlInjection(query),
    'safety.shellInjection': hasShellInjection(query),
    'provider.name': context.provider || '',
    'correlation.id': context.corr || '',
  };
}

// ============================================================
// Safety Policy Evaluator
// ============================================================

/**
 * Evaluate safety-category policies from the store against a query.
 *
 * @param {object} db - SQLite database handle
 * @param {string} orgId - Organization ID
 * @param {string} query - User query text
 * @param {object} context - { agent, provider, corr }
 * @returns {{
 *   denied: boolean, denyReason: string|null,
 *   requiresApproval: boolean, approvalReason: string|null,
 *   warnings: string[], matchedPolicies: Array,
 *   error: string|null
 * }}
 *
 * NOTE: The `error` field is non-null when evaluation fails. Callers should
 * fail-closed (return 500) on error rather than proceed with unknown state.
 */
function evaluateSafetyPolicies(db, orgId, query, context = {}) {
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
    const policies = listPolicies(db, { org_id: orgId, category: 'safety', enabled: true });
    if (!policies.data || policies.data.length === 0) return result;

    const ctx = buildSafetyContext(query, context);

    for (const policy of policies.data) {
      if (!policy.conditions) continue;

      let matches = false;
      try {
        matches = evaluateCondition(policy.conditions, ctx);
      } catch (condErr) {
        // A single bad policy shouldn't crash all policy evaluation.
        // Log and continue, but don't swallow at the outer layer.
        console.warn(`[SafetyPolicy] Condition eval failed for ${policy.name}:`, condErr.message);
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
        result.denyReason = policy.reason || `Denied by safety policy: ${policy.name}`;
      }

      if (policy.effect === 'require_approval' && !result.requiresApproval && !result.denied) {
        result.requiresApproval = true;
        result.approvalReason = policy.reason || `Requires approval per safety policy: ${policy.name}`;
      }

      if (policy.effect === 'log_only') {
        result.warnings.push(policy.reason || `Safety policy flagged: ${policy.name}`);
      }
    }
  } catch (err) {
    // DB-level error — report it so the caller can fail-closed.
    // This is the critical difference from the old fail-open pattern.
    result.error = err.message || String(err);
    console.error('[SafetyPolicy] Evaluation failed:', result.error);
  }

  return result;
}

module.exports = {
  evaluateSafetyPolicies,
  buildSafetyContext,
  hasSqlInjection,
  hasShellInjection,
  SQL_INJECTION_PATTERNS,
  SHELL_INJECTION_PATTERNS,
};
