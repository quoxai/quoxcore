/**
 * AOCL-CUTOVER-1 — L3 policy.gate.
 *
 * Wraps compliance + safety policy evaluators in the standard runL(ctx, opts)
 * contract. Pure refactor of the inline L3 block in runPreLLMPipeline. Same
 * fail-closed behaviour on evaluator error, same short-circuit on denial,
 * same approval-required handling.
 *
 * Dependency injection:
 *  - opts.voltDb                — the policy store handle. When null, L3
 *                                 skips (used in early-init / tests).
 *  - opts.evaluateCompliance    — override the compliance evaluator
 *  - opts.evaluateSafety        — override the safety evaluator
 */

const { evaluateCompliancePolicies: defaultEvalCompliance } = require('./compliancePolicyEvaluator.js');
const { evaluateSafetyPolicies: defaultEvalSafety } = require('./safetyPolicyEvaluator.js');

async function runL3(aoclCtx, opts = {}) {
  if (!aoclCtx) return { proceed: true };

  const startedAt = Date.now();
  const voltDb = opts.voltDb;

  // No policy store → skip gracefully
  if (!voltDb) {
    return {
      proceed: true,
      extras: { skipped: true, duration_ms: Date.now() - startedAt },
    };
  }

  const evalCompliance = typeof opts.evaluateCompliance === 'function' ? opts.evaluateCompliance : defaultEvalCompliance;
  const evalSafety = typeof opts.evaluateSafety === 'function' ? opts.evaluateSafety : defaultEvalSafety;

  const evalOrgId = aoclCtx.orgId || '__default__';
  const evalCtx = { agent: aoclCtx.agentId, provider: aoclCtx.provider, corr: aoclCtx.corr };
  const query = aoclCtx.C2?.rawUserPrompt || aoclCtx.query || '';

  const comp = evalCompliance(voltDb, evalOrgId, query, evalCtx) || {};
  const safety = evalSafety(voltDb, evalOrgId, query, evalCtx) || {};

  // Fail-closed on evaluator error
  if (comp.error || safety.error) {
    const errorDetail = comp.error || safety.error;
    aoclCtx.deniedAtLayer = 'L3';
    aoclCtx.firstDenialReason = `evaluator_error: ${errorDetail}`;
    aoclCtx.status = 'denied';
    return {
      proceed: false,
      reason: `evaluator_error: ${errorDetail}`,
      extras: {
        error: errorDetail,
        category: 'error',
        duration_ms: Date.now() - startedAt,
      },
    };
  }

  const matchedPolicies = [
    ...(Array.isArray(comp.matchedPolicies) ? comp.matchedPolicies : []),
    ...(Array.isArray(safety.matchedPolicies) ? safety.matchedPolicies : []),
  ];
  const warnings = [
    ...(Array.isArray(comp.warnings) ? comp.warnings : []),
    ...(Array.isArray(safety.warnings) ? safety.warnings : []),
  ];

  const denied = comp.denied || safety.denied;
  const requiresApproval = (comp.requiresApproval || safety.requiresApproval) && !denied;
  const denyReason = comp.denyReason || safety.denyReason;
  const approvalReason = comp.approvalReason || safety.approvalReason;

  if (denied) {
    const category = comp.denied ? 'compliance' : 'safety';
    aoclCtx.deniedAtLayer = 'L3';
    aoclCtx.firstDenialReason = denyReason;
    aoclCtx.status = 'denied';
    return {
      proceed: false,
      reason: denyReason,
      warnings,
      extras: {
        denied: true,
        category,
        matchedPolicies,
        duration_ms: Date.now() - startedAt,
      },
    };
  }

  if (requiresApproval) {
    aoclCtx.deniedAtLayer = 'L3';
    aoclCtx.firstDenialReason = `approval_required: ${approvalReason}`;
    aoclCtx.status = 'denied';
    return {
      proceed: false,
      reason: `approval_required: ${approvalReason}`,
      warnings,
      extras: {
        requiresApproval: true,
        approvalReason,
        matchedPolicies,
        duration_ms: Date.now() - startedAt,
      },
    };
  }

  return {
    proceed: true,
    warnings,
    extras: {
      denied: false,
      matchedPolicies,
      duration_ms: Date.now() - startedAt,
    },
  };
}

module.exports = { runL3 };
