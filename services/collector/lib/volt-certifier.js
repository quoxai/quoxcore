/**
 * AUDIT-REAL #2: VOLT bundle signature detection + Ed25519 verification.
 *
 * Root cause: bundleSigner.js (via voltContentStore.js) writes the real
 * signature onto a bundle as a SINGULAR `signature` object (see
 * voltContentStore.js `JSON.stringify({ manifest, signature: sig })`).
 * The certification code (server.js /volt/certify + runCertification/
 * buildCertResult) only ever read the PLURAL `bundle.signatures` array —
 * a shape that legacy/spec bundles may use but that real, live-signed
 * bundles never populate. Every live bundle therefore certified as
 * "no signatures" even though 300/300 verify against the persistent
 * WARD Ed25519 key.
 *
 * This module normalizes both shapes AND actually verifies each
 * signature's Ed25519 bytes (reusing Node's crypto.verify + the same
 * raw-pubkey -> SPKI DER reconstruction already used in
 * services/collector/lib/pdf/pdfManifest.js) so a structurally-present
 * but cryptographically invalid signature is never counted as signed.
 */

const crypto = require('crypto');
const { canonicalize } = require('./bundleSigner.js');
const { verifyTimestampReceipt } = require('./tsrVerifier.cjs');

// SPKI wrapper for a raw 32-byte Ed25519 public key:
// 30 2a 30 05 06 03 2b 65 70 03 21 00 <32-byte key>
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Normalize a bundle's signature(s) to an array, regardless of whether the
 * bundle uses the real singular `signature` object (current bundleSigner.js
 * format) or the legacy/spec `signatures` array.
 *
 * @param {object|null} bundle
 * @returns {object[]} array of signature records (possibly empty)
 */
function normalizeSignatures(bundle) {
  if (!bundle) return [];
  const out = [];
  if (bundle.signature && typeof bundle.signature === 'object') {
    out.push(bundle.signature);
  }
  if (Array.isArray(bundle.signatures)) {
    out.push(...bundle.signatures.filter(s => s && typeof s === 'object'));
  }
  return out;
}

/**
 * Reconstruct an Ed25519 public KeyObject from the raw 32-byte base64
 * public key embedded in a signature record.
 *
 * @param {string} publicKeyB64
 * @returns {import('crypto').KeyObject|null}
 */
function reconstructEd25519PublicKey(publicKeyB64) {
  try {
    const rawPub = Buffer.from(publicKeyB64, 'base64');
    if (rawPub.length !== 32) return null;
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, rawPub]);
    return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/**
 * VOLT-CERT-BIND: build the canonical signed message from a bundle manifest.
 *
 * This mirrors bundleSigner.js `signBundleManifest` EXACTLY (and the VOLT SDK
 * `signatureMessageFromManifest` in volt-sdk/src/sign.ts) so a signature made
 * by the collector's own signer reproduces byte-for-byte. It is the trust
 * anchor for signature binding: the verifier recomputes this from the bundle's
 * actual manifest rather than trusting the message embedded in the signature
 * record, so a signature made for bundle X cannot be transplanted onto bundle Y.
 *
 * @param {object|null} manifest
 * @returns {object|null}
 */
function signatureMessageFromManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  return {
    run_id: manifest.run_id,
    bundle_id: manifest.bundle_id,
    hash_alg: manifest.hash_alg || 'sha256',
    first_event_hash: manifest.first_event_hash,
    last_event_hash: manifest.last_event_hash,
    event_count: manifest.event_count,
  };
}

/**
 * Coerce a pinned public key (a KeyObject, a PEM string/Buffer, or a raw
 * 32-byte base64 Ed25519 key) into a KeyObject for verification. Returns null
 * when the input cannot be interpreted as an Ed25519 public key.
 *
 * The collector's pinned key is the WARD/VOLT signing key exposed via
 * getHookKeypair().publicKey (a node:crypto KeyObject) — the exact key the
 * collector signs bundles WITH (see bundleSigner.js signBundleManifest).
 *
 * @param {import('crypto').KeyObject|string|Buffer|null|undefined} input
 * @returns {import('crypto').KeyObject|null}
 */
function coercePublicKey(input) {
  if (!input) return null;
  try {
    if (typeof input === 'object' && typeof input.asymmetricKeyType === 'string') {
      return input; // already a KeyObject
    }
    if (typeof input === 'string') {
      // A raw 32-byte base64 key reconstructs via the SPKI prefix; a PEM does not.
      if (!input.includes('-----BEGIN')) {
        const rebuilt = reconstructEd25519PublicKey(input);
        if (rebuilt) return rebuilt;
      }
      return crypto.createPublicKey(input);
    }
    return crypto.createPublicKey(input);
  } catch {
    return null;
  }
}

/**
 * Cryptographically verify a single VOLT bundle signature record.
 *
 * @param {object} sig - a signature record (sig_type, message, signature, public_key)
 * @param {object} [options]
 * @param {object|null} [options.manifest] - the bundle's actual manifest. When
 *   supplied, the signature's message MUST equal the message recomputed from
 *   this manifest (VOLT-CERT-BIND); otherwise the signature is invalid, even if
 *   the bytes verify. This is what stops a transplanted / mutated-manifest
 *   signature from passing.
 * @param {import('crypto').KeyObject|string|Buffer|null} [options.pinnedPublicKey]
 *   - the collector's own known signing public key. When supplied, verification
 *   is performed against THIS key only (not the bundle-embedded key), so an
 *   attacker keypair embedded in the record can never attest validity.
 * @returns {{ valid: boolean, verified: boolean, reason?: string,
 *             key_source?: 'pinned'|'embedded', signature_trust: 'pinned'|'embedded'|'none' }}
 *   - `verified` is true only when the signature bytes were actually
 *     checked against a resolved public key and matched.
 *   - `valid` is true only when the bytes verified AND (when a manifest is
 *     given) the signature message is bound to that manifest.
 *   - `signature_trust`: `pinned` = verified against the pinned collector key
 *     (identity-verified); `embedded` = verified against the bundle-embedded
 *     key only (self-consistent, signer identity NOT verified); `none`
 *     otherwise. Non-verifiable algorithms (hmac-sha256 with no retained key,
 *     unknown sig_type) are reported as structurally present but NOT
 *     verified/valid.
 */
function verifySignature(sig, options = {}) {
  const { manifest = null, pinnedPublicKey = null } = options;

  if (!sig || typeof sig !== 'object') {
    return { valid: false, verified: false, reason: 'missing_signature', signature_trust: 'none' };
  }
  if (!sig.signature || !sig.key_id || !sig.message || !sig.sig_type) {
    return { valid: false, verified: false, reason: 'missing_required_fields', signature_trust: 'none' };
  }

  if (sig.sig_type !== 'ed25519') {
    // HMAC (or any other) fallback signatures use an ephemeral key that is
    // never persisted alongside the bundle, so there is nothing to verify
    // against. Structurally present, cryptographically unverifiable.
    return { valid: false, verified: false, reason: `unverifiable_sig_type:${sig.sig_type}`, signature_trust: 'none' };
  }

  // Resolve the verification key. A pinned collector key (identity-verified)
  // is preferred and, when present, is the ONLY key used — the bundle-embedded
  // key is never trusted to attest validity. Falling back to the embedded key
  // yields at most `embedded` trust (self-consistent, not identity-verified).
  let publicKey = null;
  let keySource = null;
  const pinned = coercePublicKey(pinnedPublicKey);
  if (pinned) {
    publicKey = pinned;
    keySource = 'pinned';
  } else {
    if (!sig.public_key) {
      return { valid: false, verified: false, reason: 'missing_public_key', signature_trust: 'none' };
    }
    publicKey = reconstructEd25519PublicKey(sig.public_key);
    if (!publicKey) {
      return { valid: false, verified: false, reason: 'invalid_public_key', signature_trust: 'none' };
    }
    keySource = 'embedded';
  }

  try {
    const data = Buffer.from(canonicalize(sig.message), 'utf-8');
    const sigBuf = Buffer.from(sig.signature, 'base64');
    const ok = crypto.verify(null, data, publicKey, sigBuf);
    if (!ok) {
      return { valid: false, verified: true, reason: 'signature_mismatch', key_source: keySource, signature_trust: 'none' };
    }

    // VOLT-CERT-BIND: the bytes verified, but that only proves the signer
    // signed *some* message. Assert that message is THIS bundle's message,
    // recomputed from the actual manifest, so a signature made for bundle X
    // cannot be transplanted onto bundle Y (or survive a mutated manifest).
    if (manifest) {
      const expected = signatureMessageFromManifest(manifest);
      if (canonicalize(sig.message) !== canonicalize(expected)) {
        return {
          valid: false,
          verified: true,
          reason: 'signature_message_mismatch',
          key_source: keySource,
          signature_trust: 'none',
        };
      }
    }

    return { valid: true, verified: true, key_source: keySource, signature_trust: keySource };
  } catch (err) {
    return { valid: false, verified: false, reason: `verify_error:${err.message}`, signature_trust: 'none' };
  }
}

/**
 * Evaluate ALL signatures found on a bundle (both singular and plural
 * shapes) and report whether at least one is a genuinely valid,
 * Ed25519-verified signature.
 *
 * @param {object|null} bundle
 * @param {object} [options]
 * @param {import('crypto').KeyObject|string|Buffer|null} [options.pinnedPublicKey]
 *   - the collector's own known signing public key (VOLT-CERT-BIND). When
 *   supplied, only signatures verified against this pinned key attest validity.
 * @returns {{
 *   has_signatures: boolean,
 *   any_valid: boolean,
 *   signature_trust: 'pinned'|'embedded'|'none',
 *   signatures: object[],
 *   results: Array<{ sig_type: string, key_id: string, valid: boolean, verified: boolean, reason?: string, key_source?: string, signature_trust: string }>
 * }}
 */
function evaluateBundleSignatures(bundle, options = {}) {
  const signatures = normalizeSignatures(bundle);
  const manifest = bundle?.manifest || null;
  const pinnedPublicKey = options.pinnedPublicKey || null;
  const results = signatures.map(sig => ({
    sig_type: sig.sig_type,
    key_id: sig.key_id,
    ...verifySignature(sig, { manifest, pinnedPublicKey }),
  }));
  const any_valid = results.some(r => r.valid);
  const signature_trust = results.some(r => r.valid && r.signature_trust === 'pinned')
    ? 'pinned'
    : results.some(r => r.valid && r.signature_trust === 'embedded')
      ? 'embedded'
      : 'none';

  return {
    has_signatures: any_valid,
    any_valid,
    signature_trust,
    signatures,
    results,
  };
}

/**
 * Detect presence of RFC 3161 timestamps on the bundle manifest.
 * Presence-only — does NOT verify the receipt cryptographically. Kept for
 * back-compat call sites that only need a cheap boolean; certification
 * (server.js Gold check) uses `verifyTimestamps()` below instead, which
 * distinguishes "absent" from "present but invalid".
 *
 * @param {object|null} manifest
 * @returns {boolean}
 */
function hasTimestamps(manifest) {
  return !!(manifest?.timestamps?.length);
}

/**
 * AUDIT-REAL #3: real RFC 3161 timestamp verification for VOLT
 * certification's Gold tier.
 *
 * Each entry in `manifest.timestamps[]` is written by
 * requestRFC3161Timestamp() (server.js) / requestTimestamp()
 * (services/ward/lib/sinks/tsa.js) as
 * `{ tsa_url, requested_at, hash_alg, hash, tsr_base64 }` — `hash` is the
 * EXACT hex value that was fed into the TSA request (see server.js
 * `manifestHash` at the /volt/cert auto-timestamp step), so it is also the
 * exact value the receipt's message imprint must match.
 *
 * Distinguishes three outcomes so the Gold check can report which one
 * occurred (mirrors the codes already used by the frontend's structural
 * checker at src/lib/volt/volt-certifier.js):
 *   - absent:            manifest.timestamps is empty/missing → NO_TIMESTAMP
 *   - present, invalid:  every entry fails cryptographic verification → TIMESTAMP_INVALID
 *   - present, valid:    at least one entry fully verifies → passes
 *
 * @param {object|null} manifest
 * @returns {Promise<{
 *   present: boolean,
 *   any_valid: boolean,
 *   outcome: 'NO_TIMESTAMP'|'TIMESTAMP_INVALID'|'VALID',
 *   results: Array<{ tsa_url: string|null, hash: string|null, valid: boolean, checks: object, errors: string[] }>
 * }>}
 */
async function verifyTimestamps(manifest) {
  const timestamps = manifest?.timestamps || [];
  if (timestamps.length === 0) {
    return { present: false, any_valid: false, outcome: 'NO_TIMESTAMP', results: [] };
  }

  const results = await Promise.all(timestamps.map(async (ts) => {
    if (!ts || !ts.tsr_base64 || !ts.hash) {
      return { tsa_url: ts?.tsa_url || null, hash: ts?.hash || null, valid: false, checks: {}, errors: ['missing tsr_base64 or hash on timestamp entry'] };
    }
    try {
      const result = await verifyTimestampReceipt({
        tsrBase64OrDer: ts.tsr_base64,
        expectedHashHex: ts.hash,
        hashAlgorithm: ts.hash_alg || 'sha256',
      });
      return { tsa_url: ts.tsa_url || null, hash: ts.hash, valid: result.valid, checks: result.checks, errors: result.errors };
    } catch (err) {
      return { tsa_url: ts.tsa_url || null, hash: ts.hash, valid: false, checks: {}, errors: [err.message] };
    }
  }));

  const any_valid = results.some(r => r.valid);
  return { present: true, any_valid, outcome: any_valid ? 'VALID' : 'TIMESTAMP_INVALID', results };
}

module.exports = {
  normalizeSignatures,
  verifySignature,
  evaluateBundleSignatures,
  hasTimestamps,
  verifyTimestamps,
  reconstructEd25519PublicKey,
  signatureMessageFromManifest,
};
