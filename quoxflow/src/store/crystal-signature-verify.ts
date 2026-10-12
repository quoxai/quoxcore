/**
 * Crystal Signature Verify — REPLAY-ONLY .B3 (verify-on-every-replay)
 *
 * Pure, local Ed25519 verification of a Crystal signature against a
 * recomputed canonical snapshot hash. No I/O — the caller (agentic.executor.ts)
 * is responsible for fetching the org's public key and recomputing the hash
 * via crystal-canonical-hash.ts's `hashSnapshot()`.
 *
 * Encoding mirrors the live prior art this stream was told to copy
 * (docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md §5 ".B scope correction"):
 * quox-dashboard `services/auth/utils/plugins.js` `verifyPluginSignature()`
 * and its signing-side counterpart `services/auth/lib/crystalSigningKey.js`
 * `verifyCrystalSignature()` — raw 32-byte Ed25519 public key wrapped in the
 * constant SubjectPublicKeyInfo DER prefix, signature verified over the raw
 * bytes of the (hex-decoded) canonical hash, no digest algorithm (Ed25519
 * signs the message directly).
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

// Constant DER header for an Ed25519 SubjectPublicKeyInfo wrapping a raw
// 32-byte public key (same constant used by auth's plugins.js / crystalSigningKey.js).
const ED25519_SPKI_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verify an Ed25519 signature (hex) over a canonical hash (hex, sha256
 * digest bytes) against a raw 32-byte public key (hex).
 *
 * Never throws — malformed hex/key material or any other error is treated
 * as a failed verification (fail-closed).
 */
export function verifyCrystalSignature(
  canonicalHashHex: string,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    const pubKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_DER_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(
      null, // Ed25519 signs the message directly — no separate digest algorithm
      Buffer.from(canonicalHashHex, 'hex'),
      pubKey,
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}
