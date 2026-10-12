'use strict';

/**
 * Tenant-isolation helpers for the compliance / auditor API family
 * (SoA, DPIA, risk classification, auditor engagements).
 *
 * THE LEAK THESE CLOSE (2026-09-24)
 * The SoA/DPIA/classification/auditor routes were written for a trusted
 * caller: list routes read `req.query.org_id` verbatim, `:id` routes did
 * `getById(req.params.id)` with NO org predicate at all, and POST routes took
 * `org_id` from the body. On a multi-org install that means org A could read
 * AND mutate org B's Statement of Applicability, DPIA, risk classification, or
 * auditor engagement simply by passing ?org_id=orgB or by guessing a record id.
 *
 * The fix mirrors the already-corrected `/compliance/reports` siblings:
 * JWT/cookie users are LOCKED to their own org; an explicit org_id is honored
 * ONLY for trusted service-key callers; a `:id` fetch is gated on ownership.
 */

/**
 * Resolve the single org a compliance request is allowed to act on.
 *
 * JWT/cookie users are LOCKED to `req.user.org_id`. An explicit org_id in the
 * query or body is honored ONLY for trusted service-key callers (`req.service`),
 * never as a user-supplied override, otherwise org A could read org B by
 * passing ?org_id=orgB. Returns null when no org can be resolved, which every
 * caller MUST treat as "see nothing", never as "see everything".
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function resolveComplianceOrgId(req) {
  if (!req) return null;
  const userOrg = req.user && req.user.org_id;
  if (userOrg) return userOrg;
  if (req.service) {
    const q = req.query && req.query.org_id;
    const b = req.body && req.body.org_id;
    return q || b || null;
  }
  return null;
}

/**
 * True only when `orgId` is a non-empty value, `row` exists, and the row
 * belongs to that org. Callers use this to gate `:id` reads and writes so one
 * org cannot fetch or mutate another org's record by id. A negative result is
 * rendered as a 404 (not 403) so record existence itself is not disclosed.
 *
 * @param {{org_id?: string}|null|undefined} row
 * @param {string|null|undefined} orgId
 * @returns {boolean}
 */
function orgOwns(row, orgId) {
  if (!orgId || !row) return false;
  return row.org_id === orgId;
}

module.exports = { resolveComplianceOrgId, orgOwns };
