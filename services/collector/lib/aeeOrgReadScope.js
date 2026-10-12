'use strict';

/**
 * Read-side tenant isolation for corr-addressed and point AEE envelope reads
 * (GET /aee/:id, GET /aee/conversation/:corr, .../bundle).
 *
 * THE LEAK THIS CLOSES (2026-09-24)
 * GET /aee/:id and GET /aee/conversation/:corr were unauthenticated and did
 * getById/getByCorr with NO org predicate — any caller could read another
 * org's DECRYPTED envelopes by id or corr. GET .../bundle was authenticated
 * but equally unscoped. The sibling-corr stitch made it worse: a broad
 * time-window + LIKE-prefix query pulled envelopes across every org.
 *
 * The predicate below mirrors the already-corrected /aee/query read path
 * (lib/aeeOrgScoping.js + queryOrgScoped): a caller sees a row only when it
 * belongs to their org, OR the row is untagged (org_id NULL — the legacy
 * pre-tagging bucket). A single corr is one conversation's causality key and
 * does not collide across orgs, so the NULL branch only re-admits that same
 * conversation's own legacy rows. The sibling-corr join deliberately does NOT
 * use this NULL-tolerant predicate (it enforces a strict `org_id = orgId` in
 * SQL) because its heuristic match could otherwise sweep another tenant's
 * untagged activity into the view.
 */

/**
 * True when a caller resolved to `orgId` may see envelope `row`. Requires a
 * non-empty orgId (no anonymous reads) and either an exact org match or an
 * untagged (NULL org) legacy row. Used for the primary corr rows and the
 * /aee/:id point read.
 *
 * @param {{org_id?: string|null}|null|undefined} row
 * @param {string|null|undefined} orgId
 * @returns {boolean}
 */
function envelopeRowVisibleToOrg(row, orgId) {
  if (!orgId || !row) return false;
  return !row.org_id || row.org_id === orgId;
}

/**
 * BRAIN2-W5 022: Feed / reflection-mining conversation reads. Discovery is
 * org-scoped, so the per-corr envelope fetch must be too: a colliding or reused
 * corr must never pull another org's envelopes into this org's document.
 * Strict org_id match (matches the discovery query); no org means no rows.
 *
 * @param {{getByCorrForOrg: {all: Function}}} stmts
 * @param {{orgId?: string, corr: string}} args
 * @returns {Array<object>}
 */
function getConversationEnvelopesForOrg(stmts, { orgId, corr }) {
  if (!orgId || !corr || !stmts || !stmts.getByCorrForOrg) return [];
  return stmts.getByCorrForOrg.all(corr, orgId);
}

module.exports = { envelopeRowVisibleToOrg, getConversationEnvelopesForOrg };
