'use strict';
// QUOXON-STEPUP: collector-side step-up gate. The verifier lives in services/shared (../../shared in the
// source tree, /app/services-shared in the image). If it cannot be resolved the gate FAILS CLOSED.
function load() {
  for (const p of ['../../shared/stepUpToken.cjs', '../services-shared/stepUpToken.cjs']) {
    try { return require(p); } catch (_e) { /* try next layout */ }
  }
  return { verifyStepUpHeader: () => ({ ok: false, reason: 'verifier_unavailable' }), stepUpEnforced: () => true };
}
const { verifyStepUpHeader, stepUpEnforced } = load();

/** Returns true to proceed; otherwise writes 403 step_up_required and returns false. */
function requireStepUp(req, res, { scope = 'approve', alwaysEnforce = false } = {}) {
  const chk = verifyStepUpHeader(req, {
    userId: req.user && req.user.id, sessionId: (req.user && req.user.session_id) || null,
    orgId: (req.user && req.user.org_id) || null, scope, secret: process.env.JWT_SECRET,
  });
  if (chk.ok) return true;
  if (!alwaysEnforce && !stepUpEnforced()) { console.warn(`[StepUp] would require step-up (not enforced): ${scope}, reason=${chk.reason}`); return true; }
  res.status(403).json({ error: 'step_up_required', reason: chk.reason, scope, message: 'A person must confirm this approval with their step-up PIN' });
  return false;
}
module.exports = { requireStepUp };
