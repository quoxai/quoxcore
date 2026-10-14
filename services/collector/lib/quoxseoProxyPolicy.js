/**
 * QuoxSEO proxy mutation policy (quox#583).
 *
 * The QuoxSEO surface is read-only by design: ingest and witnessing run on a
 * server-side timer, never through HTTP. Site REGISTRATION is the one
 * deliberate mutation, so the governed boundary allowlists exactly that and
 * refuses every other write. Kept as a pure module so the allowlist is
 * unit-testable instead of living only inside the proxy closure.
 */

/**
 * @param {string} method HTTP method as seen by the collector route
 * @param {string} path   req.path on the collector (e.g. /api/v1/quoxseo/sites)
 * @returns {{allowed: boolean, mutation: boolean}}
 *   allowed: whether the proxy may forward this request at all
 *   mutation: whether this is the governed site-registration write (needs AEE)
 */
function evaluateQuoxseoRequest(method, path) {
  const m = String(method || '').toUpperCase();
  if (m === 'GET') return { allowed: true, mutation: false };
  const isSiteRegistration = m === 'POST' && /\/quoxseo\/sites\/?$/.test(String(path || ''));
  if (isSiteRegistration) return { allowed: true, mutation: true };
  // Symmetric removal (quoxwebsite#63): DELETE /quoxseo/sites/<numeric id> only.
  if (m === 'DELETE' && /\/quoxseo\/sites\/\d+\/?$/.test(String(path || ''))) {
    return { allowed: true, mutation: true, intent: 'quox.seo.site_remove' };
  }
  return { allowed: false, mutation: false };
}

module.exports = { evaluateQuoxseoRequest };
