/**
 * GOV-E-3: L1 Identity / Scope Enforcement
 *
 * Enforces that chat requests have authenticated user and org context.
 * Mode controlled by AOCL_L1_MODE (org-scoped settings-store override, env
 * fallback):
 *   - 'observe' (default): logs warnings, never rejects — zero-disruption rollout
 *   - 'enforce': rejects requests missing userId or valid org
 *
 * Service-key callers (serviceAuth=true) bypass L1 enforcement — they are
 * already trusted internal callers (Telegram webhook, fleet agents, etc.).
 */

const configResolver = require('./configResolver.js');

const VALID_MODES = ['observe', 'enforce'];

// VAULT-INTEG P17: was a bare process.env read — now resolved via
// configResolver.getSetting(orgId, ...) (platformCapabilities.js
// AOCL_L1_MODE), called fresh on every enforceIdentity() call, so a stored
// org override applies to the very next request, no restart needed.
function getMode(orgId) {
  const resolved = configResolver.getSetting(orgId || null, 'AOCL_L1_MODE').value;
  const mode = (resolved || 'observe').toLowerCase();
  return VALID_MODES.includes(mode) ? mode : 'observe';
}

/**
 * Enforce L1 identity/scope checks.
 *
 * @param {object} aoclCtx - AOCL context bundle from aoclContext.buildAoclContext()
 * @returns {{
 *   allowed: boolean,
 *   proceed: boolean,         // alias for allowed (matches layer result shape)
 *   mode: 'observe'|'enforce',
 *   reason?: string,          // denial code when not allowed
 *   skipped?: boolean,        // true when service-auth bypass
 *   warnings: string[],       // accumulated soft warnings
 *   userId: string,
 *   orgId: string,
 *   duration_ms: number,
 * }}
 */
function enforceIdentity(aoclCtx) {
  const startTime = Date.now();
  const mode = getMode(aoclCtx.orgId);
  const warnings = [];

  const result = {
    allowed: true,
    proceed: true,
    mode,
    warnings,
    userId: aoclCtx.userId || '',
    orgId: aoclCtx.orgId || '',
    duration_ms: 0,
  };

  // Service-auth bypass: trusted internal callers skip L1
  if (aoclCtx.serviceAuth) {
    result.skipped = true;
    result.reason = 'service_auth_bypass';
    result.duration_ms = Date.now() - startTime;
    return result;
  }

  // Collect identity gaps as warnings (always)
  const hasUser = aoclCtx.userId && aoclCtx.userId.length > 0;
  const hasOrg = aoclCtx.orgId && aoclCtx.orgId.length > 0;
  const isDefaultOrg = aoclCtx.orgId === '__default__';

  if (!hasUser) warnings.push('missing_user_identity');
  if (!hasOrg) warnings.push('missing_org');
  if (isDefaultOrg) warnings.push('default_org_fallback');

  // Enforce mode: convert warnings to denials
  if (mode === 'enforce') {
    if (!hasUser) {
      result.allowed = false;
      result.proceed = false;
      result.reason = 'missing_user_identity';
    } else if (!hasOrg) {
      result.allowed = false;
      result.proceed = false;
      result.reason = 'missing_org';
    } else if (isDefaultOrg) {
      result.allowed = false;
      result.proceed = false;
      result.reason = 'default_org_fallback';
    }
  }

  result.duration_ms = Date.now() - startTime;
  return result;
}

module.exports = {
  enforceIdentity,
  getMode,
  VALID_MODES,
};
