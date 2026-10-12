/**
 * VOLT bundle digest — the canonical hash of a finalized VOLT bundle manifest.
 *
 * LICENSE-LAUNCH LL-9i4: extracted verbatim from the inline recipe that lived
 * in wardHookVOLT()'s bundle-finalization branch (services/ward/lib/hooks.js).
 * It is the payload_hash WARD chains for a bundle AND the digest the Quox
 * Verified countersignature attests. Keeping the single recipe in one exported
 * function means the local witness and the countersignature can never drift.
 *
 * Only the 6 canonical bundle fields feed the hash; any other manifest fields
 * (volt_version, corr, hash_alg, bundle_mode, producer, ...) are ignored, so a
 * full manifest and the trimmed bundle event produce the same digest.
 */

import { payloadHash } from './crypto.js';

/**
 * @param {object} bundleManifest - a VOLT bundle manifest / finalization event
 *   with { bundle_id, run_id, first_event_hash, last_event_hash, event_count,
 *   created_ts }.
 * @returns {string} 64-hex SHA-256 digest.
 */
export function voltBundleDigest(bundleManifest) {
  const m = bundleManifest || {};
  return payloadHash({
    bundle_id: m.bundle_id,
    run_id: m.run_id,
    first_event_hash: m.first_event_hash,
    last_event_hash: m.last_event_hash,
    event_count: m.event_count,
    created_ts: m.created_ts,
  });
}
