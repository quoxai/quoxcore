'use strict';

/**
 * quoxplanProxyOrg.js — decides which org a QuoxPlan proxy request forwards in
 * the X-Quoxplan-Org header.
 *
 * Cross-org roadmap placement fix: the collector's QuoxPlan proxy used to
 * forward the CALLER's own org for every request. QuoxPlan's roadmap-create
 * (`callerOrgId(req) || body.org_id || 'dev'`) lets that forwarded header win
 * over body.org_id, so an operator onboarding a customer tenant would create
 * the tenant's roadmap in the OPERATOR's org.
 *
 * This module isolates the one exception: an AUTHORIZED roadmap-create made on
 * behalf of another org. When a real user (owner/admin of the target org) POSTs
 * to the roadmaps collection with a body.org_id that differs from their active
 * org, we forward the TARGET org instead, so the roadmap lands where it belongs.
 * Every other request keeps the existing caller-org behaviour, and any failure
 * to verify the role falls back to the caller org (fail-closed: a roadmap is
 * never placed in a foreign org without a verified owner/admin role).
 *
 * Pure and deterministic given the injected `verifyOrgRole`, so it unit-tests
 * without touching the auth service.
 */

/**
 * The QuoxPlan-facing request path, without query string or trailing slash.
 * Prefers req.path (Express strips the query for us); falls back to
 * originalUrl for hand-built test requests.
 */
function quoxplanFacingPath(req) {
  let p = (req.path || (req.originalUrl || '')).split('?')[0];
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * True only for a POST to the roadmaps COLLECTION (ends with /roadmaps), not a
 * roadmap sub-resource (/roadmaps/<id>/...). Both the raw proxy path
 * (/api/v1/quoxplan/roadmaps) and the rewritten QuoxPlan path (/api/v1/roadmaps)
 * end in /roadmaps, so this holds either side of the rewrite.
 */
function isRoadmapCollectionCreate(req) {
  if (req.method !== 'POST') return false;
  return /(^|\/)roadmaps$/.test(quoxplanFacingPath(req));
}

/**
 * Resolve the org to forward in X-Quoxplan-Org.
 *
 * @param {object} req - the proxied request (needs method, path/originalUrl,
 *   user, service, headers, body).
 * @param {object} deps
 * @param {(req: object, targetOrgId: string) => Promise<string|null>} deps.verifyOrgRole
 *   returns the caller's role in targetOrgId, or null if not a member / on error.
 * @returns {Promise<{forwardOrg: string|null, onBehalfOf: boolean, targetOrg?: string, refused?: boolean}>}
 */
async function resolveQuoxplanForwardOrg(req, { verifyOrgRole }) {
  const callerOrg = req.user?.org_id || req.headers?.['x-org-id'] || null;

  const bodyOrgId = req.body?.org_id;
  const wantsOtherOrg = isRoadmapCollectionCreate(req)
    && typeof bodyOrgId === 'string'
    && bodyOrgId.length > 0
    && bodyOrgId !== callerOrg;

  // Not an on-behalf-of create: unchanged behaviour, no auth check.
  if (!wantsOtherOrg) {
    return { forwardOrg: callerOrg, onBehalfOf: false };
  }

  // A service caller has no human role to verify, so it is not eligible for
  // on-behalf-of. Keep caller behaviour rather than escalating.
  if (req.service || !req.user) {
    return { forwardOrg: callerOrg, onBehalfOf: false };
  }

  const role = await verifyOrgRole(req, bodyOrgId);
  if (role === 'owner' || role === 'admin') {
    return { forwardOrg: bodyOrgId, onBehalfOf: true, targetOrg: bodyOrgId };
  }

  // Not authorized in the target org: fall back to the caller's org. Do not
  // throw, do not escalate — the roadmap simply lands in the caller's own org.
  return { forwardOrg: callerOrg, onBehalfOf: false, refused: true };
}

module.exports = {
  resolveQuoxplanForwardOrg,
  isRoadmapCollectionCreate,
  quoxplanFacingPath,
};
