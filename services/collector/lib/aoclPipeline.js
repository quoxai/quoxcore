/**
 * GOV-E-5: AOCL Pipeline Runner
 *
 * Composes L1 (identity), L3 (compliance+safety), and L8 (response verification)
 * into clean pre-LLM and post-LLM pipeline functions. Replaces the inline layer
 * calls in handleCollectorChat with a single call per phase.
 *
 * All provider paths (Anthropic, OpenAI, Gemini, Perplexity, Local, CLI) branch
 * AFTER runPreLLMPipeline returns, so running this once covers every path.
 * runPostLLMPipeline is invoked from the res.json wrapper, giving every path
 * L8 coverage as well.
 *
 * The caller (server.js) is responsible for:
 *   - emitting AEE envelopes based on layer results
 *   - returning HTTP responses using the returned httpStatus / errorCode
 */

const { enforceIdentity } = require('./identityLayer.js');
const { evaluateCompliancePolicies } = require('./compliancePolicyEvaluator.js');
const { evaluateSafetyPolicies } = require('./safetyPolicyEvaluator.js');
const { verifyResponse } = require('./responseVerifier.js');
const configResolver = require('./configResolver.js');

// ─── Per-layer AEE envelope emission (GOV-E-6) ────────────────────────────
// The caller (server.js) registers a callback that forwards envelopes to
// storeAuditEnvelope(). Tests can capture emissions directly.
let layerEnvelopeEmitter = null;

function setLayerEnvelopeEmitter(fn) {
  layerEnvelopeEmitter = fn;
}

function getLayerEnvelopeEmitter() {
  return layerEnvelopeEmitter;
}

function emitLayerEnvelope(aoclCtx, layer, outcome, payloadExtra = {}) {
  if (!layerEnvelopeEmitter) return;
  const intent = `aocl.layer.${layer}.${outcome}`;
  // AOCL-DISPATCH-5 fix: stamp id/v/ts at emission so layer envelopes carry
  // the full AEE shape. Without these, downstream sync paths (browser cache
  // → POST /collector/aee/sync → sqlite insert) rejected them with "Too few
  // parameter values" errors on 11× more envelopes per request.
  const envelope = {
    id: `ENV_L${layer}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`.toUpperCase(),
    v: '1',
    ts: new Date().toISOString(),
    type: outcome === 'reject' ? 'error' : 'event',
    from: 'system.aocl',
    to: aoclCtx.userId ? `human.${aoclCtx.userId}` : 'human.anonymous',
    intent,
    corr: aoclCtx.corr,
    reply_to: null,
    payload: {
      layer,
      agent: aoclCtx.agentId,
      orgId: aoclCtx.orgId,
      ...payloadExtra,
    },
  };
  try {
    layerEnvelopeEmitter(envelope);
  } catch (err) {
    // Never let envelope emission crash the pipeline
    console.warn(`[AOCL] ${intent} emission failed (non-fatal):`, err.message);
  }
}

/**
 * Run the pre-LLM pipeline (L1 identity → L3 unified policy gate).
 * Short-circuits on first denial. Records results on aoclCtx.layerResults.
 *
 * @param {object|null} voltDb - voltDb handle (null disables L3 store policies)
 * @param {object} aoclCtx - AOCL context bundle
 * @returns {Promise<{
 *   proceed: boolean,
 *   deniedAtLayer: string|null,
 *   errorCode: string|null,
 *   errorMessage: string|null,
 *   httpStatus: number,
 *   warnings: string[],
 *   matchedPolicies: Array,
 * }>}
 */
async function runPreLLMPipeline(voltDb, aoclCtx) {
  const result = {
    proceed: true,
    deniedAtLayer: null,
    errorCode: null,
    errorMessage: null,
    httpStatus: 200,
    warnings: [],
    matchedPolicies: [],
  };

  // ─── L1: Identity ────────────────────────────────────────────────────────
  const l1Result = enforceIdentity(aoclCtx);
  aoclCtx.layerResults.L1 = l1Result;
  if (l1Result.warnings && l1Result.warnings.length) {
    result.warnings.push(...l1Result.warnings);
  }

  if (!l1Result.allowed) {
    emitLayerEnvelope(aoclCtx, 'L1', 'reject', {
      allowed: false,
      reason: l1Result.reason,
      mode: l1Result.mode,
      duration_ms: l1Result.duration_ms,
    });
    result.proceed = false;
    result.deniedAtLayer = 'L1';
    result.errorCode = 'identity_required';
    result.errorMessage = `L1 identity check failed: ${l1Result.reason}`;
    result.httpStatus = 401;
    aoclCtx.deniedAtLayer = 'L1';
    aoclCtx.firstDenialReason = l1Result.reason;
    aoclCtx.status = 'denied';
    return result;
  }

  emitLayerEnvelope(aoclCtx, 'L1', 'complete', {
    allowed: true,
    mode: l1Result.mode,
    skipped: l1Result.skipped || false,
    warnings: l1Result.warnings || [],
    duration_ms: l1Result.duration_ms,
  });

  // ─── L3: Unified Policy Gate (Compliance + Safety) ───────────────────────
  if (!voltDb) {
    // No policy store — skip gracefully (e.g., early-init or tests)
    return result;
  }

  const l3StartTime = Date.now();
  const evalOrgId = aoclCtx.orgId || '__default__';
  const evalCtx = { agent: aoclCtx.agentId, provider: aoclCtx.provider, corr: aoclCtx.corr };

  const comp = evaluateCompliancePolicies(voltDb, evalOrgId, aoclCtx.query, evalCtx);
  const safety = evaluateSafetyPolicies(voltDb, evalOrgId, aoclCtx.query, evalCtx);

  // Fail-closed on evaluator error
  if (comp.error || safety.error) {
    const errorDetail = comp.error || safety.error;
    const duration_ms = Date.now() - l3StartTime;
    aoclCtx.layerResults.L3 = {
      proceed: false,
      reason: 'evaluator_error',
      error: errorDetail,
      duration_ms,
    };
    emitLayerEnvelope(aoclCtx, 'L3', 'reject', {
      proceed: false,
      reason: 'evaluator_error',
      error: errorDetail,
      duration_ms,
    });
    result.proceed = false;
    result.deniedAtLayer = 'L3';
    result.errorCode = 'policy_evaluator_error';
    result.errorMessage = `Policy evaluation failed: ${errorDetail}`;
    result.httpStatus = 500;
    aoclCtx.deniedAtLayer = 'L3';
    aoclCtx.firstDenialReason = `evaluator_error: ${errorDetail}`;
    aoclCtx.status = 'denied';
    return result;
  }

  // Combine outcomes
  const denied = comp.denied || safety.denied;
  const requiresApproval = (comp.requiresApproval || safety.requiresApproval) && !denied;
  const denyReason = comp.denyReason || safety.denyReason;
  const approvalReason = comp.approvalReason || safety.approvalReason;
  const matchedPolicies = [...comp.matchedPolicies, ...safety.matchedPolicies];
  const warnings = [...comp.warnings, ...safety.warnings];

  result.matchedPolicies = matchedPolicies;
  result.warnings.push(...warnings);

  const l3Duration = Date.now() - l3StartTime;

  if (denied) {
    const category = comp.denied ? 'compliance' : 'safety';
    aoclCtx.layerResults.L3 = {
      proceed: false,
      reason: denyReason,
      category,
      matchedPolicies,
      duration_ms: l3Duration,
    };
    emitLayerEnvelope(aoclCtx, 'L3', 'reject', {
      proceed: false,
      category,
      reason: denyReason,
      matchedPolicies,
      duration_ms: l3Duration,
    });
    result.proceed = false;
    result.deniedAtLayer = 'L3';
    result.errorCode = `${category}_policy_violation`;
    result.errorMessage = denyReason;
    result.httpStatus = 403;
    aoclCtx.deniedAtLayer = 'L3';
    aoclCtx.firstDenialReason = denyReason;
    aoclCtx.status = 'denied';
    return result;
  }

  // QLUSTER-LOOP-B: a resumed delegation carries a GRANTED approval for this
  // exact request. When that grant is present, the requiresApproval gate is
  // SATISFIED — we skip the 403 and fall through to the L3-passed path below,
  // emitting an approval_satisfied envelope for the audit trail. This is reached
  // ONLY after L1 identity (:102) and the hard policy-deny branch (:181) have
  // both passed — a granted resume is still denied by a real policy-deny or an
  // identity failure, and L8 still runs post-LLM. The grant itself is only ever
  // set on aoclCtx by an internal-service-authed resume (see server.js), never
  // by a JWT/browser request.
  if (requiresApproval && !aoclCtx.approvalGranted) {
    aoclCtx.layerResults.L3 = {
      proceed: false,
      reason: 'approval_required',
      approvalReason,
      matchedPolicies,
      duration_ms: l3Duration,
    };
    emitLayerEnvelope(aoclCtx, 'L3', 'reject', {
      proceed: false,
      reason: 'approval_required',
      approvalReason,
      matchedPolicies,
      duration_ms: l3Duration,
    });
    result.proceed = false;
    result.deniedAtLayer = 'L3';
    result.errorCode = 'approval_required';
    result.errorMessage = approvalReason;
    result.httpStatus = 403;
    aoclCtx.deniedAtLayer = 'L3';
    aoclCtx.firstDenialReason = `approval_required: ${approvalReason}`;
    aoclCtx.status = 'denied';
    return result;
  }

  // L3 passed — either cleanly, or because a resumed delegation satisfied the
  // HITL gate (approval_satisfied). Note the grant + inbox item in the envelope.
  const approvalSatisfied = requiresApproval && aoclCtx.approvalGranted;
  aoclCtx.layerResults.L3 = {
    proceed: true,
    warnings,
    matchedPolicies,
    duration_ms: l3Duration,
    ...(approvalSatisfied
      ? { approvalSatisfied: true, inbox_item_id: aoclCtx.approvalInboxItemId || null }
      : {}),
  };
  emitLayerEnvelope(aoclCtx, 'L3', 'complete', {
    proceed: true,
    warnings,
    matchedPolicies,
    duration_ms: l3Duration,
    ...(approvalSatisfied
      ? { reason: 'approval_satisfied', approvalReason, inbox_item_id: aoclCtx.approvalInboxItemId || null }
      : {}),
  });

  return result;
}

/**
 * Run the post-LLM pipeline (L8 response verification).
 * Invoked from the res.json wrapper in handleCollectorChat.
 *
 * @param {object} aoclCtx - AOCL context bundle
 * @param {string} responseText - The assembled LLM response text
 * @param {object} context - Additional context: { hasRAG }
 * @returns {Promise<{ valid, reason?, checks, warnings, formats?, duration_ms, mode }>}
 */
async function runPostLLMPipeline(aoclCtx, responseText, context = {}) {
  const l8StartTime = Date.now();
  // VAULT-INTEG P17: was a bare process.env read — now resolved via
  // configResolver.getSetting(orgId, ...) (platformCapabilities.js
  // AOCL_L8_MODE), called fresh on every runPostLLMPipeline() call.
  const mode = (configResolver.getSetting(aoclCtx.orgId || null, 'AOCL_L8_MODE').value || 'enforce').toLowerCase();

  const l8Result = await verifyResponse(responseText, {
    query: aoclCtx.query,
    agent: aoclCtx.agentId,
    corr: aoclCtx.corr,
    hasRAG: context.hasRAG || false,
  });

  const duration_ms = l8Result.duration_ms || (Date.now() - l8StartTime);
  aoclCtx.layerResults.L8 = {
    proceed: l8Result.valid,
    valid: l8Result.valid,
    reason: l8Result.reason,
    checks: l8Result.checks,
    warnings: l8Result.warnings,
    formats: l8Result.formats,
    duration_ms,
  };

  emitLayerEnvelope(aoclCtx, 'L8', l8Result.valid ? 'complete' : 'reject', {
    valid: l8Result.valid,
    reason: l8Result.reason,
    checksRun: l8Result.checks ? l8Result.checks.length : 0,
    warningCount: l8Result.warnings ? l8Result.warnings.length : 0,
    responseLength: responseText ? responseText.length : 0,
    formats: l8Result.formats,
    duration_ms,
  });

  return {
    ...l8Result,
    mode,
  };
}

// ─── AOCL-FULL-1: runPipeline iterator + EXPECTED_LAYERS constant ───────────
//
// The new core. Takes an ordered stack definition and runs each layer in
// sequence. Every layer follows the contract:
//    async run(aoclCtx): Promise<LayerResult>
// where LayerResult = {
//    proceed: boolean,        // false → short-circuit pipeline
//    reason?: string,         // short denial/bypass reason
//    httpStatus?: number,     // surfaced to HTTP caller on reject
//    errorCode?: string,
//    warnings?: string[],
//    extras?: object,         // merged into the aocl.layer.<id>.complete payload
//    bypass?: boolean,        // if true, emit .bypass instead of .complete
// }
//
// Halt signal: a layer can set `aoclCtx.halt = { reason, response }` to
// short-circuit. The runner then proceeds through the remaining layers but
// emits `.bypass` for each with the halt reason. This is how L2 fast-path
// works — smart-router cache hit skips L3/L5/L6/L7 but still produces audit.

/**
 * Single source of truth for which layers the pipeline emits. Tests read
 * from this rather than hard-coding intent names. Each phase of AOCL-FULL
 * extends this constant when it adds a layer.
 */
// AOCL-FULL-4: L0/L2/L10 added. AOCL-FULL-5: L5/L6 added.
// AOCL-FULL-6: L7/L9 added. AOCL-FULL-7: L4 added — canonical set complete.
const EXPECTED_LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10'];

/**
 * Run a stack definition end-to-end.
 * @param {object} aoclCtx
 * @param {{ layers: Array<{ id: string, run: (ctx) => Promise<object> }> }} stackDef
 * @returns {Promise<{
 *   proceed: boolean,
 *   deniedAtLayer: string|null,
 *   errorCode: string|null,
 *   errorMessage: string|null,
 *   httpStatus: number,
 *   warnings: string[],
 *   matchedPolicies: Array,
 *   layersRun: string[],
 *   layersBypassed: string[],
 * }>}
 */
async function runPipeline(aoclCtx, stackDef, opts = {}) {
  const result = {
    proceed: true,
    deniedAtLayer: null,
    errorCode: null,
    errorMessage: null,
    httpStatus: 200,
    warnings: [],
    matchedPolicies: [],
    layersRun: [],
    layersBypassed: [],
  };

  if (!stackDef || !Array.isArray(stackDef.layers)) {
    return result;
  }

  // AOCL-FULL-3: apply per-layer timeout budgets before iteration. Slow
  // layers produce .bypass instead of stalling the request.
  // Opt out by passing { budgets: false }.
  let effectiveStack = stackDef;
  if (opts.budgets !== false) {
    const { applyBudgets } = require('./layerBudget.js');
    effectiveStack = applyBudgets(stackDef, opts.budgetOverrides || {});
  }

  for (const layer of effectiveStack.layers) {
    const { id } = layer;
    if (!id || typeof layer.run !== 'function') continue;

    // If a previous layer set a halt signal, every subsequent layer emits
    // .bypass with the halt reason instead of running.
    if (aoclCtx.halt) {
      emitLayerEnvelope(aoclCtx, id, 'bypass', {
        reason: aoclCtx.halt.reason,
      });
      result.layersBypassed.push(id);
      continue;
    }

    const startedAt = Date.now();
    let layerResult;
    try {
      layerResult = await layer.run(aoclCtx);
    } catch (err) {
      // Layer threw. Emit .reject with the error message. Stop pipeline.
      const duration_ms = Date.now() - startedAt;
      const reason = err?.message || 'layer_exception';
      aoclCtx.layerResults[id] = { proceed: false, reason, duration_ms, exception: true };
      emitLayerEnvelope(aoclCtx, id, 'reject', { reason, duration_ms, exception: true });
      result.proceed = false;
      result.deniedAtLayer = id;
      result.errorCode = 'layer_exception';
      result.errorMessage = `Layer ${id} threw: ${reason}`;
      result.httpStatus = 500;
      aoclCtx.deniedAtLayer = id;
      aoclCtx.firstDenialReason = reason;
      aoclCtx.status = 'error';
      return result;
    }

    const duration_ms = Date.now() - startedAt;
    const safeResult = layerResult && typeof layerResult === 'object' ? layerResult : { proceed: true };
    const extras = safeResult.extras || {};
    aoclCtx.layerResults[id] = {
      ...safeResult,
      ...extras,
      duration_ms,
    };

    if (Array.isArray(safeResult.warnings) && safeResult.warnings.length) {
      result.warnings.push(...safeResult.warnings);
    }
    if (Array.isArray(safeResult.matchedPolicies)) {
      result.matchedPolicies.push(...safeResult.matchedPolicies);
    }

    // Pick emission outcome
    let outcome;
    if (safeResult.bypass === true) outcome = 'bypass';
    else if (safeResult.proceed === false) outcome = 'reject';
    else outcome = 'complete';

    emitLayerEnvelope(aoclCtx, id, outcome, {
      ...extras,
      reason: safeResult.reason,
      duration_ms,
    });

    if (outcome === 'bypass') {
      result.layersBypassed.push(id);
    } else {
      result.layersRun.push(id);
    }

    if (safeResult.proceed === false) {
      result.proceed = false;
      result.deniedAtLayer = id;
      result.errorCode = safeResult.errorCode || `${id.toLowerCase()}_denied`;
      result.errorMessage = safeResult.errorMessage || safeResult.reason || `${id} denied`;
      result.httpStatus = safeResult.httpStatus || 403;
      aoclCtx.deniedAtLayer = id;
      aoclCtx.firstDenialReason = safeResult.reason || 'denied';
      aoclCtx.status = 'denied';
      return result;
    }
  }

  return result;
}

module.exports = {
  runPipeline,
  runPreLLMPipeline,
  runPostLLMPipeline,
  setLayerEnvelopeEmitter,
  getLayerEnvelopeEmitter,
  emitLayerEnvelope,
  EXPECTED_LAYERS,
};
