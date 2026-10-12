'use strict';

/**
 * WARD-RECEIPT-GAP: resolve the real WARD witness receipt for a VOLT bundle.
 *
 * Diagnosis (2026-07-27, live-verified): witnessing genuinely happens —
 * autoBundleOnComplete() (lib/voltContentStore.js) calls wardHookVOLT()
 * unconditionally for every completed run, which appends a real hash-chained
 * entry to ward_entries (source_kind='VOLT', source_id=bundle_id). But the
 * bundle export route only ever reported witnessed:true when the bundle's
 * own JSON carried an embedded `ward_receipt` field — and nothing writes
 * that field. wardHookVOLT() is fire-and-forget by design (SPEC §22.1) and
 * its return value (the entry) was simply dropped on the floor. Result: the
 * receipt exists and is cryptographically chained, but no read path ever
 * looked it back up.
 *
 * FIX CHOSEN: read-path chain lookup by source_id (bundle_id), not
 * persist-at-write-time. Reasons:
 *   1. The ward_entries row already exists for every bundle wardHookVOLT()
 *      was ever called on — that is every bundle written since WARD hooks
 *      were wired into autoBundleOnComplete. A lookup fixes those bundles
 *      retroactively with zero backfill migration. Persist-at-write-time
 *      would only fix bundles created after the fix ships; every bundle
 *      already on disk would stay MISSING forever.
 *   2. It cannot be gamed by editing volt_bundles.data after the fact,
 *      because ward_entries is a separate, append-only table the bundle
 *      write path never touches — recomputing the hash from the CURRENT
 *      manifest and comparing to the hash actually chained at witness time
 *      (below) catches exactly that tamper case.
 *
 * NOT optimistic: an entry existing is necessary but not sufficient. The
 * payload hash is recomputed from the manifest fields available now and
 * compared byte-for-byte to the hash WARD chained at witness time. Any
 * mismatch — including "an entry exists but doesn't match" — reports
 * witnessed:false. Reporting witnessed:true on anything less would fake the
 * exact thing customers are paying for.
 */

/**
 * @param {object} deps
 * @param {Function} deps.getEntryBySource - (chainId, sourceKind, sourceId) => entry|null
 *   Same signature as services/ward/lib/store.js#getEntryBySource.
 * @param {Function} deps.payloadHash - (obj) => sha256 hex string
 *   WARD's canonical hasher (services/ward/lib/crypto.js#payloadHash) — MUST
 *   be the same function WARD used when it computed the entry's hash, or
 *   every real receipt will spuriously fail as a "mismatch".
 * @param {string|null|undefined} deps.chainId - WARD chain ID the bundle was
 *   witnessed on (getHookChainId()). Null/undefined means WARD hooks were
 *   never initialised — reported as unavailable, not as unwitnessed-tamper.
 * @param {Function} [deps.getCoveringTip] - (chainId, seq) => tip|null —
 *   earliest signed chain tip with tip_seq >= seq (services/ward/lib/
 *   store.js#getCoveringTip). Optional: a caller that cannot reach tips
 *   gets an honest `signature.status: 'tip_unavailable'`, never a crash.
 * @param {object} manifest - the VOLT bundle manifest as built by
 *   autoBundleOnComplete: { bundle_id, run_id, first_event_hash,
 *   last_event_hash, event_count, created_ts }
 * @returns {{ witnessed: boolean, receipt: object|null, reason?: string }}
 *   reason is only set when witnessed is false, for logging/debugging —
 *   never surfaced as a "witnessed" signal itself.
 */
/**
 * quox#515 — the honest signature block for a receipt. WARD entries are
 * hash-chained but individually UNSIGNED by design: Ed25519 signatures (and
 * RFC-3161 TSA countersignatures) are applied to periodic chain TIPS, each
 * of which covers every entry up to its tip_seq. The old receipt surfaced
 * the dead per-entry sig column as `sig: null` beside `witnessed: true`,
 * which two independent round-3 assessor runs read as an unsigned witness.
 * This block states the model and returns the covering signed tip instead.
 */
function resolveSignatureBlock(deps, entry) {
  const { getCoveringTip, chainId } = deps || {};
  const base = {
    model: 'tip-signed',
    note: 'WARD entries are hash-chained and individually unsigned by design; Ed25519 signatures and RFC-3161 TSA countersignatures are applied to periodic chain tips. A tip with tip_seq >= this entry\'s seq covers it: verify the tip sig over tip_chain_hash with key_id, then the hash chain from this entry to the tip.',
  };
  if (typeof getCoveringTip !== 'function') {
    return { ...base, status: 'tip_unavailable', signed_tip: null };
  }
  let tip = null;
  try {
    tip = getCoveringTip(chainId, entry.seq);
  } catch (_) {
    return { ...base, status: 'tip_unavailable', signed_tip: null };
  }
  if (!tip || !tip.sig) {
    // Chained but not yet covered by a signed tip (entry newer than the
    // last tip cut) — pending is the truth, not "unsigned".
    return { ...base, status: 'pending_tip', signed_tip: null };
  }
  return {
    ...base,
    status: 'tip_signed',
    signed_tip: {
      tip_id: tip.tip_id,
      tip_seq: tip.tip_seq,
      tip_chain_hash: tip.tip_chain_hash,
      sig: tip.sig,
      key_id: tip.key_id ?? null,
      created_at: tip.created_at ?? null,
      tsa_countersigned: !!tip.tsr,
    },
  };
}

function resolveWardReceiptForBundle(deps, manifest) {
  const { getEntryBySource, payloadHash, chainId } = deps || {};

  if (!manifest || !manifest.bundle_id) {
    return { witnessed: false, receipt: null, reason: 'no_manifest' };
  }
  if (typeof getEntryBySource !== 'function' || typeof payloadHash !== 'function' || !chainId) {
    // WARD not initialised/available on this process — honest "don't know",
    // never fabricated as witnessed.
    return { witnessed: false, receipt: null, reason: 'ward_unavailable' };
  }

  let entry;
  try {
    entry = getEntryBySource(chainId, 'VOLT', manifest.bundle_id);
  } catch (err) {
    return { witnessed: false, receipt: null, reason: 'lookup_failed' };
  }
  if (!entry) {
    // Genuinely never witnessed (or witnessed on a different chain_id than
    // this process is configured for) — false is correct here.
    return { witnessed: false, receipt: null, reason: 'not_witnessed' };
  }

  // Recompute the exact hash wardHookVOLT()'s bundle-finalization branch
  // computed at witness time (services/ward/lib/hooks.js) from the manifest
  // fields as they read NOW. If volt_bundles.data was altered after being
  // witnessed, this will not match and we fail closed.
  const expectedHash = payloadHash({
    bundle_id: manifest.bundle_id,
    run_id: manifest.run_id ?? null,
    first_event_hash: manifest.first_event_hash ?? null,
    last_event_hash: manifest.last_event_hash ?? null,
    event_count: manifest.event_count ?? null,
    created_ts: manifest.created_ts ?? null,
  });

  if (expectedHash !== entry.payload_hash) {
    return { witnessed: false, receipt: null, reason: 'hash_mismatch' };
  }

  return {
    witnessed: true,
    receipt: {
      ward_entry_id: entry.ward_entry_id,
      chain_id: entry.chain_id,
      seq: entry.seq,
      witnessed_at: entry.witnessed_at,
      source_kind: entry.source_kind,
      source_id: entry.source_id,
      payload_hash: entry.payload_hash,
      prev_chain_hash: entry.prev_chain_hash,
      chain_hash: entry.chain_hash,
      issuer_id: entry.issuer_id,
      // quox#515: no per-entry `sig` field — that column is null by design
      // and printing it beside witnessed:true reads as an unsigned witness.
      signature: resolveSignatureBlock(deps, entry),
    },
  };
}

module.exports = { resolveWardReceiptForBundle };
