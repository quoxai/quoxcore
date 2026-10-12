/**
 * WARD Verifier — 5-step chain integrity verification.
 * VERIFICATION.md §3, §4, §5
 *
 * G3d (2026-09-28): verification is BOUNDED so it can never monopolise the
 * collector event loop. verifyChain() used to load the ENTIRE chain into memory
 * and hash every entry synchronously; on a multi-million-entry chain that pegs a
 * core for minutes and times out every other collector request (login,
 * tool-execute, witnessed writes). Worse, the public unauthenticated endpoint
 * could trigger it. Now:
 *   - normal-size chains (<= maxEntries) verify exactly as before (no change),
 *   - a chain larger than the cap is verified over a bounded window (genesis
 *     anchor + the head window) and returns PARTIAL/BOUNDED_LARGE_CHAIN instead
 *     of walking everything,
 *   - callers can page a full verify with fromSeq/upToSeq (bounded per call).
 * The synchronous work per call is therefore capped, which is what removes the
 * DoS. Ties quox#622 (user-verifiable, bounded WARD verify).
 */

import { genesisHash, chainHash } from './crypto.js';
import { getChain, getEntries, getEntriesRange, getTipsInRange, firstTipBelow, firstTipAbove, countTipsOutside, getEntryBySource, getEntryBySourceAnyChain, getCoveringTip } from './store.js';
import { verifyTipSignature } from './signing.js';

// The most entries a single synchronous verify call will walk. A walk of this
// many sha256s is milliseconds, not minutes, so it cannot starve the event loop.
// Not env-only: callers (endpoints) pass an explicit cap; this is the safe default.
export const DEFAULT_MAX_ENTRIES = 25000;

/**
 * Walk a contiguous run of entries, validating seq ordering, chain linkage and
 * chain-hash for each. Returns { broken } on the first failure (a full BROKEN
 * result), or { prevHash, lastEntry } on success.
 *
 * @param {object[]} entries - contiguous entries, ascending seq
 * @param {string} chainId
 * @param {string} startPrevHash - the chain_hash the first entry must link to
 * @param {number} expectedStartSeq - the seq the first entry must have
 * @param {Set<string>|null} seenSources - when provided, enforce global source
 *   uniqueness (only meaningful for a full-chain walk; null for a window, where
 *   uniqueness is a whole-chain property that a window cannot establish)
 */
function walkEntries(entries, chainId, startPrevHash, expectedStartSeq, seenSources) {
  let prevHash = startPrevHash;
  let lastEntry = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const expectedSeq = expectedStartSeq + i;

    if (entry.seq !== expectedSeq) {
      return { broken: { status: 'BROKEN', chain_id: chainId, reason: 'SEQ_INVALID', details: { expected_seq: expectedSeq, found_seq: entry.seq, ward_entry_id: entry.ward_entry_id } } };
    }

    if (entry.prev_chain_hash !== prevHash) {
      return { broken: { status: 'BROKEN', chain_id: chainId, reason: 'CHAIN_LINK_BROKEN', details: { seq: entry.seq, ward_entry_id: entry.ward_entry_id, expected_prev: prevHash, found_prev: entry.prev_chain_hash } } };
    }

    const computed = chainHash({
      prevChainHash: entry.prev_chain_hash,
      chainId,
      seq: entry.seq,
      wardEntryId: entry.ward_entry_id,
      timestamp: entry.witnessed_at,
      sourceKind: entry.source_kind,
      sourceId: entry.source_id,
      payloadHash: entry.payload_hash
    });

    if (computed !== entry.chain_hash) {
      return { broken: { status: 'BROKEN', chain_id: chainId, reason: 'CHAIN_HASH_MISMATCH', details: { seq: entry.seq, ward_entry_id: entry.ward_entry_id, expected_chain_hash: computed, found_chain_hash: entry.chain_hash } } };
    }

    if (seenSources) {
      const sourceKey = `${entry.source_kind}:${entry.source_id}`;
      if (seenSources.has(sourceKey)) {
        return { broken: { status: 'BROKEN', chain_id: chainId, reason: 'DUPLICATE_SOURCE', details: { seq: entry.seq, source_kind: entry.source_kind, source_id: entry.source_id } } };
      }
      seenSources.add(sourceKey);
    }

    prevHash = entry.chain_hash;
    lastEntry = entry;
  }

  return { prevHash, lastEntry };
}

/**
 * Validate the tips whose tip_seq falls inside a verified window. Tips that
 * reference a seq outside the window are reported (not verified here) rather than
 * failing the result. Returns { broken } or { tipsVerified, signaturesVerified,
 * tipsOutsideWindow, warnings }.
 */
function verifyTipsInWindow(chainId, windowFrom, windowTo, windowEntriesBySeq, opts, isFullChain = false) {
  // Only this window's tips are read (ONE-BRAIN CX1: loading every tip per
  // 100-entry slice pinned the collector). Check order matches the old
  // ascending walk: tips below the window, then the window, then above it.
  let tipsVerified = 0;
  let signaturesVerified = 0;
  let tipsOutsideWindow = 0;
  const warnings = [];
  // On a FULL verify, a tip pointing past the head (or before seq 1) means the
  // chain is missing entries the tip commits to: that is INCOMPLETE_CHAIN, the
  // long-standing behavior. On a bounded/paged window it is simply a tip this
  // window did not cover, so it is reported, not failed.
  const incomplete = (tip) => ({ broken: { status: 'PARTIAL', chain_id: chainId, reason: 'INCOMPLETE_CHAIN', details: { verified_through_seq: windowTo, tip_references_seq: tip.tip_seq } } });
  if (isFullChain) {
    const below = firstTipBelow(chainId, windowFrom);
    if (below) return incomplete(below);
  } else {
    tipsOutsideWindow = countTipsOutside(chainId, windowFrom, windowTo);
  }

  for (const tip of getTipsInRange(chainId, windowFrom, windowTo)) {
    const tipEntry = windowEntriesBySeq.get(tip.tip_seq);
    if (!tipEntry) {
      return { broken: { status: 'PARTIAL', chain_id: chainId, reason: 'INCOMPLETE_CHAIN', details: { window_from: windowFrom, window_to: windowTo, tip_references_seq: tip.tip_seq } } };
    }
    if (tip.tip_chain_hash !== tipEntry.chain_hash) {
      return { broken: { status: 'BROKEN', chain_id: chainId, reason: 'TIP_MISMATCH', details: { tip_id: tip.tip_id, tip_seq: tip.tip_seq, expected: tipEntry.chain_hash, found: tip.tip_chain_hash } } };
    }
    tipsVerified++;

    if (tip.sig && opts.publicKey) {
      if (!verifyTipSignature(tip.tip_chain_hash, tip.sig, opts.publicKey)) {
        return { broken: { status: 'BROKEN', chain_id: chainId, reason: 'TIP_SIGNATURE_INVALID', details: { tip_id: tip.tip_id, tip_seq: tip.tip_seq, key_id: tip.key_id } } };
      }
      signaturesVerified++;
    } else if (tip.sig && !opts.publicKey) {
      if (opts.requireSignatures) {
        return { broken: { status: 'BROKEN', chain_id: chainId, reason: 'SIGNATURE_REQUIRED', details: { tip_id: tip.tip_id, tip_seq: tip.tip_seq, key_id: tip.key_id, message: 'tip carries a signature but no public key was available to verify it (refusing silent downgrade)' } } };
      }
      warnings.push(`Tip ${tip.tip_id} has signature but no public key provided for verification`);
    }
  }

  if (isFullChain) {
    const above = firstTipAbove(chainId, windowTo);
    if (above) return incomplete(above);
  }
  return { tipsVerified, signaturesVerified, tipsOutsideWindow, warnings };
}

/**
 * Verify a WARD chain's integrity. Returns a ward_verification_result.
 *
 * @param {string} chainId - The chain to verify
 * @param {object} [opts]
 * @param {import('crypto').KeyObject} [opts.publicKey] - Ed25519 public key used
 *   to verify tip signatures. When absent, signed tips cannot be verified.
 * @param {number} [opts.fromSeq] - Verify from this seq (default 1). Windowed
 *   verifies do not re-establish genesis; continuity is anchored on the entry
 *   immediately before fromSeq.
 * @param {number} [opts.upToSeq] - Verify only up to this seq (default head).
 * @param {number} [opts.maxEntries] - Cap on entries walked in ONE call
 *   (default DEFAULT_MAX_ENTRIES). This is the DoS guard.
 * @param {boolean} [opts.requireSignatures] - refuse to silently downgrade a
 *   signed-capable tip.
 * @returns {object} Verification result (INTACT | BROKEN | PARTIAL)
 */
export function verifyChain(chainId, opts = {}) {
  const chain = getChain(chainId);
  if (!chain) {
    return { status: 'BROKEN', chain_id: chainId, reason: 'CHAIN_NOT_FOUND', details: { message: 'Chain does not exist' } };
  }

  const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0 ? Math.floor(opts.maxEntries) : DEFAULT_MAX_ENTRIES;
  const totalCount = chain.entry_count || 0;
  const headSeq = chain.head_seq || 0;

  if (totalCount === 0) {
    return {
      status: 'INTACT', chain_id: chainId, ward_version: '0.1',
      entry_count: 0, head_seq: 0, head_chain_hash: chain.genesis_hash,
      genesis_verified: true, tips_verified: 0, signatures_verified: 0, warnings: []
    };
  }

  const explicitWindow = opts.fromSeq != null || opts.upToSeq != null;
  const fromSeq = opts.fromSeq && opts.fromSeq > 1 ? Math.floor(opts.fromSeq) : 1;
  const upToSeq = opts.upToSeq && opts.upToSeq > 0 && opts.upToSeq < headSeq ? Math.floor(opts.upToSeq) : headSeq;

  if (fromSeq > upToSeq) {
    return { status: 'BROKEN', chain_id: chainId, reason: 'RANGE_INVALID', details: { fromSeq, upToSeq, message: 'fromSeq must be <= upToSeq' } };
  }

  const expectedGenesis = genesisHash(chainId);

  // ── Case A: full verify that fits under the cap — EXACT legacy behavior ──
  if (fromSeq === 1 && upToSeq === headSeq && totalCount <= maxEntries) {
    const entries = getEntries(chainId);

    const firstEntry = entries[0];
    if (firstEntry.seq !== 1) {
      return { status: 'BROKEN', chain_id: chainId, reason: 'SEQ_INVALID', details: { message: 'First entry seq is not 1', found_seq: firstEntry.seq } };
    }
    if (firstEntry.prev_chain_hash !== expectedGenesis) {
      return { status: 'BROKEN', chain_id: chainId, reason: 'GENESIS_MISMATCH', details: { expected: expectedGenesis, found: firstEntry.prev_chain_hash } };
    }

    const seenSources = new Set();
    const walk = walkEntries(entries, chainId, expectedGenesis, 1, seenSources);
    if (walk.broken) return walk.broken;

    const bySeq = new Map(entries.map(e => [e.seq, e]));
    const tipResult = verifyTipsInWindow(chainId, 1, headSeq, bySeq, opts, true);
    if (tipResult.broken) return tipResult.broken;

    const lastEntry = walk.lastEntry;
    return {
      status: 'INTACT', chain_id: chainId, ward_version: '0.1',
      entry_count: entries.length, head_seq: lastEntry.seq, head_chain_hash: lastEntry.chain_hash,
      genesis_verified: true, tips_verified: tipResult.tipsVerified, signatures_verified: tipResult.signaturesVerified,
      warnings: tipResult.warnings
    };
  }

  // ── Case B: an explicit window larger than the cap — refuse, tell them to page ──
  const requestedWindow = upToSeq - fromSeq + 1;
  if (explicitWindow && requestedWindow > maxEntries) {
    return {
      status: 'PARTIAL', chain_id: chainId, reason: 'WINDOW_TOO_LARGE',
      details: { requested_window: requestedWindow, max_entries: maxEntries, message: `page the verify in windows of at most ${maxEntries} via fromSeq/upToSeq` }
    };
  }

  // ── Case C: no explicit window but the chain exceeds the cap — bounded verify ──
  // Verify genesis anchor + the head window. Never loads the whole chain.
  if (!explicitWindow && totalCount > maxEntries) {
    const firstArr = getEntriesRange(chainId, 1, 1);
    const firstEntry = firstArr[0];
    if (!firstEntry || firstEntry.seq !== 1) {
      return { status: 'BROKEN', chain_id: chainId, reason: 'SEQ_INVALID', details: { message: 'First entry seq is not 1', found_seq: firstEntry?.seq } };
    }
    if (firstEntry.prev_chain_hash !== expectedGenesis) {
      return { status: 'BROKEN', chain_id: chainId, reason: 'GENESIS_MISMATCH', details: { expected: expectedGenesis, found: firstEntry.prev_chain_hash } };
    }

    const winFrom = Math.max(2, headSeq - maxEntries + 1);
    const anchorArr = getEntriesRange(chainId, winFrom - 1, winFrom - 1);
    const anchor = anchorArr[0];
    if (!anchor) {
      return { status: 'BROKEN', chain_id: chainId, reason: 'INCOMPLETE_CHAIN', details: { message: 'anchor entry missing for head window', anchor_seq: winFrom - 1 } };
    }
    const winEntries = getEntriesRange(chainId, winFrom, headSeq);
    const walk = walkEntries(winEntries, chainId, anchor.chain_hash, winFrom, null);
    if (walk.broken) return walk.broken;

    const bySeq = new Map(winEntries.map(e => [e.seq, e]));
    const tipResult = verifyTipsInWindow(chainId, winFrom, headSeq, bySeq, opts);
    if (tipResult.broken) return tipResult.broken;

    const lastEntry = walk.lastEntry;
    return {
      status: 'PARTIAL', chain_id: chainId, reason: 'BOUNDED_LARGE_CHAIN', ward_version: '0.1',
      entry_count: totalCount, head_seq: lastEntry ? lastEntry.seq : headSeq,
      head_chain_hash: lastEntry ? lastEntry.chain_hash : null,
      genesis_verified: true,
      verified_range: { genesis: true, from: winFrom, to: headSeq },
      max_entries: maxEntries,
      tips_verified: tipResult.tipsVerified, signatures_verified: tipResult.signaturesVerified,
      tips_outside_window: tipResult.tipsOutsideWindow,
      warnings: [...tipResult.warnings, `chain has ${totalCount} entries (> ${maxEntries}); verified genesis + head window [${winFrom}..${headSeq}]. Page with fromSeq/upToSeq for full coverage.`]
    };
  }

  // ── Case D: an explicit window within the cap (paging) ──
  let startPrevHash;
  let genesisVerified = false;
  if (fromSeq === 1) {
    startPrevHash = expectedGenesis;
    genesisVerified = true;
  } else {
    const anchorArr = getEntriesRange(chainId, fromSeq - 1, fromSeq - 1);
    const anchor = anchorArr[0];
    if (!anchor) {
      return { status: 'BROKEN', chain_id: chainId, reason: 'INCOMPLETE_CHAIN', details: { message: 'anchor entry missing for window', anchor_seq: fromSeq - 1 } };
    }
    startPrevHash = anchor.chain_hash;
  }

  const winEntries = getEntriesRange(chainId, fromSeq, upToSeq);
  if (fromSeq === 1 && winEntries[0] && winEntries[0].prev_chain_hash !== expectedGenesis) {
    return { status: 'BROKEN', chain_id: chainId, reason: 'GENESIS_MISMATCH', details: { expected: expectedGenesis, found: winEntries[0].prev_chain_hash } };
  }
  const walk = walkEntries(winEntries, chainId, startPrevHash, fromSeq, null);
  if (walk.broken) return walk.broken;

  const fullChain = fromSeq === 1 && upToSeq === headSeq;
  const bySeq = new Map(winEntries.map(e => [e.seq, e]));
  const tipResult = verifyTipsInWindow(chainId, fromSeq, upToSeq, bySeq, opts, fullChain);
  if (tipResult.broken) return tipResult.broken;

  const lastEntry = walk.lastEntry;
  return {
    status: fullChain ? 'INTACT' : 'PARTIAL',
    chain_id: chainId, ward_version: '0.1',
    entry_count: totalCount,
    head_seq: lastEntry ? lastEntry.seq : upToSeq,
    head_chain_hash: lastEntry ? lastEntry.chain_hash : null,
    genesis_verified: genesisVerified,
    verified_range: { genesis: genesisVerified, from: fromSeq, to: upToSeq },
    tips_verified: tipResult.tipsVerified, signatures_verified: tipResult.signaturesVerified,
    tips_outside_window: tipResult.tipsOutsideWindow,
    warnings: tipResult.warnings,
    ...(fullChain ? {} : { reason: 'WINDOWED' })
  };
}

/**
 * #622: verify a SINGLE action's inclusion receipt without recomputing the
 * whole chain. `verifyChain` re-walks every entry from genesis — on the
 * production chain (~3M entries) that is a CPU-bound job that pegs the
 * collector. But an auditor asking "prove THIS agent action is in your
 * tamper-evident log" only needs to prove one entry is committed under a
 * signed tip. That proof is bounded: verify the segment from the entry up to
 * its earliest covering SIGNED tip (tips are cut every N entries), then check
 * the tip's Ed25519 signature. Changing the entry would change every chain
 * hash forward to the tip and break the tip signature, so this segment IS a
 * sound inclusion proof — in O(tip_gap), not O(chain).
 *
 * @param {object} opts
 * @param {string} [opts.chainId] - chain to look in; if omitted, resolved from
 *   the source id across all chains (idx_ward_entries_source).
 * @param {string} [opts.sourceKind='AEE'] - AEE | AOCL | VOLT | WARD | EXTERNAL
 * @param {string} opts.sourceId - the source event id (e.g. an AEE envelope id)
 * @param {import('crypto').KeyObject} [opts.publicKey] - WARD tip public key
 * @param {boolean} [opts.requireSignatures] - fail if a signed-capable tip
 *   cannot be verified (no key), instead of warning.
 * @returns {object} receipt result:
 *   WITNESSED | NOT_WITNESSED | UNTIPPED | BROKEN
 */
export function verifyReceipt(opts = {}) {
  const { sourceKind = 'AEE', sourceId, publicKey, requireSignatures } = opts;
  if (!sourceId) {
    return { status: 'BROKEN', reason: 'SOURCE_REQUIRED', details: { message: 'sourceId is required' } };
  }

  // Resolve the entry (and its chain, if the caller did not pass one).
  let entry;
  let chainId = opts.chainId;
  if (chainId) {
    entry = getEntryBySource(chainId, sourceKind, sourceId);
  } else {
    entry = getEntryBySourceAnyChain(sourceKind, sourceId);
    if (entry) chainId = entry.chain_id;
  }
  if (!entry) {
    return {
      status: 'NOT_WITNESSED',
      reason: 'SOURCE_NOT_FOUND',
      chain_id: chainId || null,
      source_kind: sourceKind,
      source_id: sourceId,
      details: { message: 'no witness entry exists for this source id' }
    };
  }

  const chain = getChain(chainId);
  if (!chain) {
    return { status: 'BROKEN', reason: 'CHAIN_NOT_FOUND', chain_id: chainId, details: { message: 'entry references a chain that does not exist' } };
  }

  // 1. The entry self-verifies: its stored chain_hash recomputes from its own
  //    fields + stored prev_chain_hash.
  const computedEntryHash = chainHash({
    prevChainHash: entry.prev_chain_hash,
    chainId,
    seq: entry.seq,
    wardEntryId: entry.ward_entry_id,
    timestamp: entry.witnessed_at,
    sourceKind: entry.source_kind,
    sourceId: entry.source_id,
    payloadHash: entry.payload_hash
  });
  if (computedEntryHash !== entry.chain_hash) {
    return {
      status: 'BROKEN', reason: 'CHAIN_HASH_MISMATCH', chain_id: chainId,
      source_kind: sourceKind, source_id: sourceId,
      details: { seq: entry.seq, ward_entry_id: entry.ward_entry_id, expected_chain_hash: computedEntryHash, found_chain_hash: entry.chain_hash }
    };
  }

  // 2. Find the earliest SIGNED tip that covers this entry (tip_seq >= seq).
  const tip = getCoveringTip(chainId, entry.seq);
  if (!tip) {
    // The entry exists and self-hashes, but no signed tip vouches for it yet.
    // Honest state: recorded, not yet attested. Not a failure.
    return {
      status: 'UNTIPPED', reason: 'NO_COVERING_TIP', chain_id: chainId,
      source_kind: sourceKind, source_id: sourceId,
      entry: { ward_entry_id: entry.ward_entry_id, seq: entry.seq, witnessed_at: entry.witnessed_at, chain_hash: entry.chain_hash },
      details: { message: 'entry is recorded and self-consistent but no signed tip covers it yet' }
    };
  }

  // 3. Verify the bounded segment [entry.seq .. tip.tip_seq]: forward links and
  //    per-entry chain-hash recompute. This is the only unbounded-in-principle
  //    step, but it spans at most one tip interval, not the whole chain.
  const segment = getEntriesRange(chainId, entry.seq, tip.tip_seq);
  let prevHash = entry.prev_chain_hash;
  let expectedSeq = entry.seq;
  for (const e of segment) {
    if (e.seq !== expectedSeq) {
      return { status: 'BROKEN', reason: 'SEQ_INVALID', chain_id: chainId, details: { expected_seq: expectedSeq, found_seq: e.seq, ward_entry_id: e.ward_entry_id } };
    }
    if (e.prev_chain_hash !== prevHash) {
      return { status: 'BROKEN', reason: 'CHAIN_LINK_BROKEN', chain_id: chainId, details: { seq: e.seq, ward_entry_id: e.ward_entry_id, expected_prev: prevHash, found_prev: e.prev_chain_hash } };
    }
    const c = chainHash({
      prevChainHash: e.prev_chain_hash, chainId, seq: e.seq, wardEntryId: e.ward_entry_id,
      timestamp: e.witnessed_at, sourceKind: e.source_kind, sourceId: e.source_id, payloadHash: e.payload_hash
    });
    if (c !== e.chain_hash) {
      return { status: 'BROKEN', reason: 'CHAIN_HASH_MISMATCH', chain_id: chainId, details: { seq: e.seq, ward_entry_id: e.ward_entry_id, expected_chain_hash: c, found_chain_hash: e.chain_hash } };
    }
    prevHash = e.chain_hash;
    expectedSeq++;
  }

  // The last segment entry must BE the tip's entry, and the tip must commit to
  // its chain hash.
  const tipEntry = segment[segment.length - 1];
  if (!tipEntry || tipEntry.seq !== tip.tip_seq) {
    return { status: 'BROKEN', reason: 'INCOMPLETE_CHAIN', chain_id: chainId, details: { tip_seq: tip.tip_seq, verified_through_seq: tipEntry ? tipEntry.seq : entry.seq - 1 } };
  }
  if (tip.tip_chain_hash !== tipEntry.chain_hash) {
    return {
      status: 'BROKEN', reason: 'TIP_MISMATCH', chain_id: chainId,
      details: { tip_id: tip.tip_id, tip_seq: tip.tip_seq, expected: tipEntry.chain_hash, found: tip.tip_chain_hash }
    };
  }

  // 4. Verify the tip signature (the actual attestation).
  let signatureVerified = false;
  const warnings = [];
  if (tip.sig && publicKey) {
    if (!verifyTipSignature(tip.tip_chain_hash, tip.sig, publicKey)) {
      return { status: 'BROKEN', reason: 'TIP_SIGNATURE_INVALID', chain_id: chainId, details: { tip_id: tip.tip_id, tip_seq: tip.tip_seq, key_id: tip.key_id } };
    }
    signatureVerified = true;
  } else if (tip.sig && !publicKey) {
    if (requireSignatures) {
      return {
        status: 'BROKEN', reason: 'SIGNATURE_REQUIRED', chain_id: chainId,
        details: { tip_id: tip.tip_id, tip_seq: tip.tip_seq, key_id: tip.key_id, message: 'covering tip is signed but no public key was available to verify it (refusing silent downgrade)' }
      };
    }
    warnings.push(`Covering tip ${tip.tip_id} is signed but no public key was provided for verification`);
  }

  return {
    status: 'WITNESSED',
    chain_id: chainId,
    source_kind: sourceKind,
    source_id: sourceId,
    entry: { ward_entry_id: entry.ward_entry_id, seq: entry.seq, witnessed_at: entry.witnessed_at, chain_hash: entry.chain_hash },
    covering_tip: {
      tip_id: tip.tip_id,
      tip_seq: tip.tip_seq,
      signed: !!tip.sig,
      signature_verified: signatureVerified,
      timestamped: !!tip.tsr,
      key_id: tip.key_id || null
    },
    segment_verified: segment.length,
    warnings
  };
}
