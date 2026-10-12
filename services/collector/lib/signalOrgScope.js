/**
 * QuoxSignal proxy org scoping (F07 fix).
 *
 * The /api/v1/signal/* proxy in server.js derives the authenticated caller's
 * org via resolveCallerOrgId(req) and license-checks THAT org, but was then
 * forwarding req.originalUrl (query string, incl. any caller-supplied
 * org_id) and req.body (incl. any org_id field) unchanged to the upstream
 * quox-signal service. Upstream's orgIdOf(req) trusts
 * req.query.org_id || req.body.org_id, so a licensed caller for org A could
 * pass org_id=orgB on the query string or in the body and read/write org
 * B's data.
 *
 * These two pure helpers force the verified callerOrgId onto the outbound
 * request, stripping any caller-supplied org_id first, so same-org callers
 * see no behavior change and cross-org callers can no longer override their
 * own scope.
 */

/**
 * Rebuild a target path+query string with org_id forced to callerOrgId.
 * Any existing org_id param (caller-supplied) is removed first.
 *
 * @param {string} targetPath - path plus optional '?query' (e.g. the
 *   already-rewritten /api/v1/... path used to build the upstream URL).
 * @param {string} callerOrgId - the verified org of the authenticated caller.
 * @returns {string} the path+query with org_id forced to callerOrgId.
 */
function scopeSignalTargetToOrg(targetPath, callerOrgId) {
  const qIdx = targetPath.indexOf('?');
  const pathPart = qIdx === -1 ? targetPath : targetPath.slice(0, qIdx);
  const queryPart = qIdx === -1 ? '' : targetPath.slice(qIdx + 1);

  const params = new URLSearchParams(queryPart);
  params.delete('org_id');
  if (callerOrgId != null) {
    params.set('org_id', callerOrgId);
  }
  const qs = params.toString();
  return qs ? `${pathPart}?${qs}` : pathPart;
}

/**
 * Return a shallow-copied body with org_id forced to callerOrgId. Non-object
 * bodies (null, undefined, arrays, primitives) are returned unchanged since
 * there is no org_id field to scope.
 *
 * @param {*} body - req.body as received from the client.
 * @param {string} callerOrgId - the verified org of the authenticated caller.
 * @returns {*} the scoped body.
 */
function scopeSignalBodyToOrg(body, callerOrgId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return { ...body, org_id: callerOrgId };
}

module.exports = { scopeSignalTargetToOrg, scopeSignalBodyToOrg };
