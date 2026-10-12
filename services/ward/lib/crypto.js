/**
 * WARD Cryptographic Primitives (SPEC §4)
 *
 * SHA-256 hashing, genesis hash, chain hash, and JSON canonicalization.
 * All per WARD SPEC v0.1.
 */

import { createHash } from 'crypto';

/**
 * SHA-256 hash, returned as lowercase hex (64 chars).
 * SPEC §4.1, §4.2
 */
export function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Genesis hash for a chain. SPEC §4.3
 * genesis_hash = SHA-256("WARD-GENESIS|" + chain_id)
 */
export function genesisHash(chainId) {
  return sha256(`WARD-GENESIS|${chainId}`);
}

/**
 * Chain hash linking an entry to its predecessor. SPEC §4.4
 *
 * chain_hash = SHA-256(prev_chain_hash + "|" + chain_id + "|" + seq + "|"
 *   + ward_entry_id + "|" + timestamp + "|" + source_kind + "|" + source_id
 *   + "|" + payload_hash)
 */
export function chainHash({ prevChainHash, chainId, seq, wardEntryId, timestamp, sourceKind, sourceId, payloadHash }) {
  const input = [
    prevChainHash,
    chainId,
    String(seq),
    wardEntryId,
    timestamp,
    sourceKind,
    sourceId,
    payloadHash
  ].join('|');
  return sha256(input);
}

/**
 * Canonical JSON for payload hash computation. SPEC §3.2
 * Keys sorted lexicographically at every nesting level, no whitespace,
 * UTF-8, no exponent notation.
 */
export function canonicalize(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean') return String(obj);
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') return JSON.stringify(obj.normalize('NFC'));

  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }

  const keys = Object.keys(obj).sort();
  const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k]));
  return '{' + pairs.join(',') + '}';
}

/**
 * Compute SHA-256 payload hash of an object using canonical JSON.
 */
export function payloadHash(obj) {
  return sha256(canonicalize(obj));
}
