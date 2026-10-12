/**
 * AOCL-CUTOVER-1 — L1 identity.scope.
 *
 * Wraps enforceIdentity() from identityLayer.js in the standard
 * runL(ctx, opts) contract used by L0/L2/L4..L10. Pure refactor:
 * same observable behaviour as the inline L1 block in runPreLLMPipeline,
 * just reshaped so buildChatStack can compose it declaratively.
 *
 * The underlying enforceIdentity is injectable for testability — callers
 * (including the legacy runPreLLMPipeline during cutover shadow mode)
 * can pass in mocks without touching the identity module itself.
 */

const { enforceIdentity: defaultEnforceIdentity } = require('./identityLayer.js');

/**
 * Run the L1 identity scope check.
 *
 * @param {object} aoclCtx
 * @param {object} [opts]
 * @param {(ctx) => { allowed, reason?, mode?, skipped?, warnings?, duration_ms? }} [opts.enforceIdentity]
 */
async function runL1(aoclCtx, opts = {}) {
  if (!aoclCtx) return { proceed: true };

  const startedAt = Date.now();
  const enforce = typeof opts.enforceIdentity === 'function' ? opts.enforceIdentity : defaultEnforceIdentity;
  const r = enforce(aoclCtx) || {};
  const warnings = Array.isArray(r.warnings) ? r.warnings : [];
  const duration_ms = typeof r.duration_ms === 'number' ? r.duration_ms : Date.now() - startedAt;

  if (!r.allowed) {
    aoclCtx.deniedAtLayer = 'L1';
    aoclCtx.firstDenialReason = r.reason || 'identity_required';
    aoclCtx.status = 'denied';
    return {
      proceed: false,
      reason: r.reason || 'identity_required',
      warnings,
      extras: {
        allowed: false,
        mode: r.mode || 'enforce',
        skipped: r.skipped || false,
        duration_ms,
      },
    };
  }

  return {
    proceed: true,
    warnings,
    extras: {
      allowed: true,
      mode: r.mode || 'enforce',
      skipped: r.skipped || false,
      duration_ms,
    },
  };
}

module.exports = { runL1 };
