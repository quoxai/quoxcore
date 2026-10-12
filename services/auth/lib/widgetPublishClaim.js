/**
 * QCX-2.4 — Widget publish governance claim.
 *
 * Every successful widget publish produces a claim: "widget X reached
 * security score S on simulation run R at time T by user U". The claim is
 * canonicalised (deterministic bytes) and sha256'd, giving a stable
 * manifest_hash that a downstream WARD witness can chain. For dev-only
 * publishes (no simulation required) the claim records dev_only=true + a
 * null security_score — the hash remains deterministic.
 *
 * Pure module: no IO, no DB. Callers persist the result + emit any AEE
 * envelopes. Uses the WARD canonicalize + sha256 primitives so when the
 * full WARD witness pipeline arrives, the hash values align without
 * re-canonicalisation.
 */

import { randomBytes } from 'crypto';
import { canonicalize, sha256 } from '../../ward/lib/crypto.js';

function _require(input, field) {
  const v = input?.[field];
  if (v === undefined || v === null || v === '') {
    throw new Error(`${field} is required to build a publish claim`);
  }
  return v;
}

export function canonicalPayload(payload) {
  // canonicalize (from ward/lib/crypto) returns RFC 8785 JSON canonicalization
  // — key-sorted, no whitespace, stable number encoding.
  return canonicalize(payload);
}

function generateClaimId() {
  const ts = Date.now().toString(36);
  const rnd = randomBytes(4).toString('hex');
  return `CLM_${ts}_${rnd}`.toUpperCase();
}

/**
 * Builds a widget publish claim.
 *
 * @param {object} input
 * @param {string} input.widget_id
 * @param {string} input.org_id
 * @param {number|null} input.security_score  Null when dev_only.
 * @param {string|null} input.simulation_run_id  Null when dev_only.
 * @param {string} input.published_at  ISO-8601.
 * @param {string} input.published_by_user_id
 * @param {boolean} [input.dev_only]  True when published via dev-domain bypass.
 * @returns {{claim_id, manifest_hash, issued_at, payload, canonical_payload}}
 */
export function buildPublishClaim(input) {
  const widget_id = _require(input, 'widget_id');
  const org_id = _require(input, 'org_id');
  const published_at = _require(input, 'published_at');
  const published_by_user_id = _require(input, 'published_by_user_id');
  const dev_only = !!input.dev_only;

  const payload = {
    claim_type: 'quoxchat.widget.published',
    version: '1',
    widget_id,
    org_id,
    published_at,
    published_by_user_id,
    security_score: (typeof input.security_score === 'number') ? input.security_score : null,
    simulation_run_id: input.simulation_run_id || null,
    dev_only,
  };

  const canonical = canonicalize(payload);
  const manifest_hash = sha256(canonical);

  return {
    claim_id: generateClaimId(),
    manifest_hash,
    issued_at: published_at,
    payload,
    canonical_payload: canonical,
  };
}
