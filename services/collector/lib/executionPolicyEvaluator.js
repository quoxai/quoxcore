/**
 * GOV-5: Execution Policy Evaluator
 *
 * Resolves execution-category policies from the store and evaluates them
 * against a request context. Used by the resolve-plan endpoint to apply
 * org-level rate limits, token budgets, and model restrictions.
 */

const { listPolicies } = require('./policyStore.js');
const { evaluateCondition } = require('./conditionEvaluator.js');

/**
 * Fetch and evaluate execution policies from the store.
 * Returns matched policies sorted by priority (highest first).
 *
 * @param {object} db - SQLite database handle
 * @param {string} orgId - Organization ID
 * @param {object} ctx - Flat context for condition evaluation
 * @returns {Array} Matched execution policies
 */
function resolveExecutionPolicies(db, orgId, ctx = {}) {
  if (!db) return [];

  try {
    const result = listPolicies(db, { org_id: orgId, category: 'execution', enabled: true });
    if (!result.data || result.data.length === 0) return [];

    const matched = [];
    for (const policy of result.data) {
      if (!policy.conditions) continue;
      if (evaluateCondition(policy.conditions, ctx)) {
        matched.push(policy);
      }
    }

    return matched;
  } catch (err) {
    console.warn('[ExecutionPolicy] Failed to resolve:', err.message);
    return [];
  }
}

/**
 * Evaluate execution policies and return constraints.
 * Processes policies in priority order (highest first).
 * First deny wins. Allow policies are recorded but don't block deny evaluation.
 *
 * @param {object} db - SQLite database handle
 * @param {string} orgId - Organization ID
 * @param {object} ctx - Flat context
 * @returns {{ denied: boolean, denyReason: string|null, warnings: string[], matchedPolicies: Array }}
 */
function getExecutionConstraints(db, orgId, ctx = {}) {
  const matched = resolveExecutionPolicies(db, orgId, ctx);
  const warnings = [];
  let denied = false;
  let denyReason = null;

  for (const policy of matched) {
    if (policy.effect === 'deny' && !denied) {
      // Check if a higher-priority allow already matched
      const higherAllow = matched.find(p => p.effect === 'allow' && p.priority > policy.priority);
      if (!higherAllow) {
        denied = true;
        denyReason = policy.reason || `Denied by execution policy: ${policy.name}`;
      }
    }

    if (policy.effect === 'log_only') {
      warnings.push(policy.reason || `Execution policy flagged: ${policy.name}`);
    }
  }

  return {
    denied,
    denyReason,
    warnings,
    matchedPolicies: matched.map(p => ({ id: p.id, name: p.name, effect: p.effect })),
  };
}

module.exports = { resolveExecutionPolicies, getExecutionConstraints };
