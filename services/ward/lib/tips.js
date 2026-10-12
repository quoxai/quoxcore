/**
 * WARD Tips — checkpoint creation, signing, and meta-chain support.
 * SPEC §8, §12, §13
 */

import { randomUUID } from 'crypto';
import { getChain, getEntryBySeq, insertTip, getLatestTip } from './store.js';
import { payloadHash } from './crypto.js';
import { signTipHash } from './signing.js';
import { witness } from './witness.js';

/**
 * Create a tip (checkpoint) for a chain at the current head.
 *
 * @param {string} chainId - The chain to checkpoint
 * @param {object} [opts]
 * @param {string} [opts.notes] - Human-readable annotation
 * @param {object} [opts.keypair] - { privateKey, keyId } for Ed25519 signing
 * @returns {object|null} The tip, or null if chain empty/not found
 */
export function createTip(chainId, opts = {}) {
  const chain = getChain(chainId);
  if (!chain || chain.head_seq === 0) return null;

  const headEntry = getEntryBySeq(chainId, chain.head_seq);
  if (!headEntry) return null;

  const tip = {
    tip_id: randomUUID(),
    chain_id: chainId,
    tip_seq: chain.head_seq,
    tip_chain_hash: headEntry.chain_hash,
    entry_count: chain.entry_count,
    created_at: new Date().toISOString(),
    sig: null,
    key_id: null,
    sink_ref: null,
    notes: opts.notes || null
  };

  // Sign the tip if a keypair is provided (SPEC §12.2)
  if (opts.keypair && opts.keypair.privateKey) {
    tip.sig = signTipHash(tip.tip_chain_hash, opts.keypair.privateKey);
    tip.key_id = opts.keypair.keyId || null;
  }

  insertTip(tip);
  return tip;
}

/**
 * Check if a tip should be created based on entry count since last tip.
 *
 * @param {string} chainId
 * @param {number} interval - Create tip every N entries (default 100)
 * @returns {boolean}
 */
export function shouldCreateTip(chainId, interval = 100) {
  const chain = getChain(chainId);
  if (!chain || chain.head_seq === 0) return false;

  const lastTip = getLatestTip(chainId);
  const lastTipSeq = lastTip ? lastTip.tip_seq : 0;
  return (chain.head_seq - lastTipSeq) >= interval;
}

/**
 * Auto-create a tip if the interval has been reached.
 */
export function autoTip(chainId, interval = 100) {
  if (shouldCreateTip(chainId, interval)) {
    return createTip(chainId, { notes: `Auto-tip at interval ${interval}` });
  }
  return null;
}

/**
 * Compute payload hash for a tip (for meta-chain witnessing).
 */
export function tipPayloadHash(tip) {
  return payloadHash({
    tip_id: tip.tip_id,
    chain_id: tip.chain_id,
    tip_seq: tip.tip_seq,
    tip_chain_hash: tip.tip_chain_hash,
    entry_count: tip.entry_count,
    created_at: tip.created_at
  });
}

/**
 * Witness a tip in a meta-chain. SPEC §13
 *
 * Meta-chain source_id format: "<sub_chain_id>::<tip_seq>" (double colon separator).
 * source_kind = 'WARD', payload_hash = SHA-256 of canonical tip JSON.
 *
 * @param {string} metaChainId - The meta-chain ID (e.g. "ward:meta/quox-global")
 * @param {object} tip - The tip to witness
 * @returns {object|null} The meta-chain entry, or null
 */
export function witnessTipInMetaChain(metaChainId, tip) {
  const sourceId = `${tip.chain_id}::${tip.tip_seq}`;
  const hash = tipPayloadHash(tip);
  return witness({
    chainId: metaChainId,
    sourceKind: 'WARD',
    sourceId,
    payloadHash: hash,
    scope: `Meta-chain for ${metaChainId}`
  });
}
