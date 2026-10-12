/**
 * aeeOrgScoping.js — org_id derivation for AEE envelopes.
 *
 * Extracted so the derivation logic used by storeAuditEnvelope() (server.js)
 * is unit-testable in isolation. No fabrication: every path either returns a
 * real org id sourced from the envelope/request, or null. Never invents an
 * org for background/fleet writers that legitimately have no tenant context.
 *
 * Precedent for the `org.<org_id>` address convention: the cross-org filter
 * at server.js (GET /aee query route) and lib/chainGuards/crossOrgVerifier.js
 * both parse/emit addresses of the form `org.<org_id>` for federated envelopes.
 */

'use strict';

/**
 * Parse an org id out of an AEE address using the `org.<org_id>` convention.
 * Returns null for any other address shape (human.*, agent.*, system.*, etc.)
 * or non-string input.
 *
 * @param {string} addr
 * @returns {string|null}
 */
function parseOrgAddress(addr) {
  if (typeof addr !== 'string' || !addr.startsWith('org.')) return null;
  const orgId = addr.slice(4);
  return orgId.length > 0 ? orgId : null;
}

/**
 * Try the `from` address first, then `to` — matches the existing cross-org
 * query filter's treatment of either side of an envelope as org-tagged.
 *
 * @param {string} from
 * @param {string} to
 * @returns {string|null}
 */
function parseOrgFromAddress(from, to) {
  return parseOrgAddress(from) || parseOrgAddress(to) || null;
}

/**
 * Derive the org_id to persist for an envelope, in priority order:
 *   1. envelope.org_id (explicit, set by a call-site that already resolved
 *      the real tenant — e.g. chat dispatch's jwtOrgId)
 *   2. envelope.payload.orgId OR envelope.payload.org_id — the SAME fact under
 *      two spellings, because the codebase writes both (see below)
 *   3. org.<org_id> address convention on `from`/`to` (federated/cross-org
 *      chain envelopes — lib/chainGuards/crossOrgVerifier.js)
 *   4. null — honest "unknown", never fabricated.
 *
 * WHY BOTH SPELLINGS (2026-08-18, and it was a live tenancy leak)
 * This read `payload.orgId` only. Meanwhile 37 emitting call sites write
 * `payload: { org_id: ... }` in snake_case and 34 write `orgId` in camelCase —
 * the repo genuinely uses both, and the slot routes are among the snake_case
 * ones. Every envelope from a snake_case call site therefore derived null and
 * was stored untagged.
 *
 * That matters far beyond a missing column, because GET /aee/query resolves
 * untagged rows WITHOUT ANY ORG PREDICATE: queryOrgScoped is
 * `org_id = $orgId UNION ALL org_id IS NULL`, and the second branch filters on
 * nothing, so every caller of every tenant receives the whole NULL bucket.
 * Measured on this install: 1,638,873 of 1,737,223 envelopes (94.3%) were
 * untagged. It was not a legacy backlog either — the newest untagged row was
 * newer than the newest tagged one, so it was still happening every second.
 *
 * PRECISION ABOUT THE EVIDENCE (corrected 2026-08-18, same session). The first
 * write-up of this claimed a nonexistent-org query had returned ANOTHER org's
 * envelopes. That overstated what was actually shown. The query parameter was
 * ignored because the calling token binds its own org and req.user.org_id wins,
 * which is correct behaviour, and the rows that came back carried the CALLER's
 * own org in their payloads. So what is demonstrated is that the NULL branch is
 * unfiltered and returns untagged rows to whoever asks; what is NOT
 * demonstrated, on this effectively single-tenant box, is a row belonging to a
 * different tenant actually reaching a caller. The defect is structural and
 * would leak on a genuinely multi-tenant install. Fix it on that basis, not on
 * a claim the evidence does not support.
 *
 * Accepting both spellings stops new envelopes joining that bucket. It does NOT
 * retroactively tag the 1.6M already there, and it does not change the
 * UNION-ALL-NULL read shape; both are tracked separately, because a backfill
 * needs payload decryption and dropping the NULL branch would hide legitimately
 * tenant-less platform envelopes from everyone.
 *
 * @param {object} envelope
 * @returns {string|null}
 */
function deriveEnvelopeOrgId(envelope) {
  if (!envelope) return null;
  // `??` alone would let an empty string through, and `org_id = ''` is a THIRD
  // bucket that matches no tenant's queries and is not the NULL bucket either:
  // the same invisibility problem wearing a different hat. Only a non-blank
  // string counts as a real tag.
  const firstReal = (...candidates) => {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim() !== '') return c;
    }
    return null;
  };
  return firstReal(
    envelope.org_id,
    envelope.payload?.orgId,
    envelope.payload?.org_id,
    parseOrgFromAddress(envelope.from, envelope.to),
  );
}

/**
 * QUOXTRUST FND_..SPCJ (tenant isolation) — authoritative org for an AEE store/sync request.
 * An authenticated USER is LOCKED to their verified token org and NEVER falls through to the
 * caller-controlled envelope org: otherwise a user whose token carries a falsy org_id (a real,
 * validly-signed orgless state) could set envelope.org_id / payload.org_id / the from-address to
 * any victim org and attribute or witness a forged envelope into that tenant's evidence trail.
 * Only a trusted service-key caller (or the unauthenticated shadow-mode path, which the auth gate
 * 401s under enforcement) may take the org from the body/envelope.
 *
 * @param {object} req      - express request (req.user / req.service populated by the auth gate)
 * @param {object} envelope - the envelope (or req.body) to derive a service/shadow org from
 * @returns {string|null}
 */
function resolveAeeOrgId(req, envelope) {
  if (req && req.user) return req.user.org_id || null;
  if (req && req.service) return (req.body && req.body.org_id) || deriveEnvelopeOrgId(envelope || {});
  return deriveEnvelopeOrgId(envelope || {});
}

module.exports = { parseOrgFromAddress, deriveEnvelopeOrgId, resolveAeeOrgId };
