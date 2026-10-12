/**
 * AOCL-CUTOVER-1 — L8 verify.check.
 *
 * Wraps verifyResponse() from responseVerifier.js in the standard
 * runL(ctx, opts) contract. Pure refactor of the inline L8 block in
 * runPostLLMPipeline. Post-LLM layer: reads the assembled response from
 * C5 (preferring finalResponse, falling back to llmResponse), returns
 * proceed:false on a verification failure in enforce mode, or warnings
 * in warn mode.
 *
 * AOCL_L8_MODE: 'enforce' (default) | 'warn', org-scoped settings-store
 * override with env fallback. In warn mode a failed verification still
 * proceeds but surfaces warnings for the audit trail — matches the
 * pre-existing behaviour of runPostLLMPipeline.
 */

const { verifyResponse: defaultVerify } = require('./responseVerifier.js');
const configResolver = require('./configResolver.js');

async function runL8(aoclCtx, opts = {}) {
  if (!aoclCtx) return { proceed: true };

  const startedAt = Date.now();
  const verify = typeof opts.verify === 'function' ? opts.verify : defaultVerify;
  // VAULT-INTEG P17: was a bare process.env read — now resolved via
  // configResolver.getSetting(orgId, ...) (platformCapabilities.js
  // AOCL_L8_MODE), called fresh on every runL8() call. opts.mode (an
  // explicit test/caller override) still wins over both.
  const mode = (opts.mode || configResolver.getSetting(aoclCtx.orgId || null, 'AOCL_L8_MODE').value || 'enforce').toLowerCase();

  const c5 = aoclCtx.C5 || {};
  const responseText = typeof c5.finalResponse === 'string' && c5.finalResponse.length > 0
    ? c5.finalResponse
    : (typeof c5.llmResponse === 'string' && c5.llmResponse.length > 0 ? c5.llmResponse : '');

  if (!responseText) {
    // Nothing to verify — bypass (L8 only makes sense after L7/L9 produced output)
    return {
      proceed: true,
      bypass: true,
      reason: 'l8.no_response',
      extras: { duration_ms: Date.now() - startedAt },
    };
  }

  const query = aoclCtx.C2?.rawUserPrompt || aoclCtx.query || '';
  const r = (await verify(responseText, {
    query,
    agent: aoclCtx.agentId,
    corr: aoclCtx.corr,
    hasRAG: opts.hasRAG || false,
  })) || {};

  const duration_ms = typeof r.duration_ms === 'number' ? r.duration_ms : Date.now() - startedAt;
  const checks = Array.isArray(r.checks) ? r.checks : [];
  const verifierWarnings = Array.isArray(r.warnings) ? r.warnings : [];

  const extras = {
    valid: r.valid,
    reason: r.reason,
    checks_run: checks.length,
    warning_count: verifierWarnings.length,
    response_length: responseText.length,
    formats: r.formats,
    mode,
    duration_ms,
  };

  if (r.valid === false && mode === 'enforce') {
    aoclCtx.deniedAtLayer = 'L8';
    aoclCtx.firstDenialReason = r.reason || 'verification_failed';
    aoclCtx.status = 'denied';
    return {
      proceed: false,
      reason: r.reason || 'verification_failed',
      warnings: verifierWarnings,
      extras,
    };
  }

  // warn mode or valid — proceed, surface warnings
  const warnings = [...verifierWarnings];
  if (r.valid === false) warnings.unshift(`L8 warn: ${r.reason || 'verification_failed'}`);

  return {
    proceed: true,
    warnings,
    extras,
  };
}

module.exports = { runL8 };
