/**
 * AUD-PDF Phase 0: canonical report hash + WARD signature + PDF metadata
 *
 * Mirrors the pattern already in bundleSigner.js so one verification
 * workflow covers JSON assurance packs AND PDF reports:
 *
 *   1. canonicalize(report) — sorted-keys JSON, no whitespace
 *   2. SHA-256 of the canonical string → manifest_hash
 *   3. Ed25519 signature over the manifest_hash using the WARD keypair
 *      (fallback to ephemeral key when WARD is absent, flagged with
 *      warning='ephemeral_key_not_verifiable' so verifiers know)
 *   4. manifest_hash + signature + public_key + keyId embedded in the
 *      PDF's Keywords field as JSON — auditors can re-derive and verify
 *
 * Pure functions, no side effects. Injectable `getHookKeypair` so
 * tests can pass a known keypair.
 */

const crypto = require('crypto');

function canonicalize(val) {
  if (val === null || val === undefined) return JSON.stringify(val);
  if (typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map((v) => canonicalize(v)).join(',') + ']';
  const sorted = Object.keys(val).filter((k) => val[k] !== undefined).sort();
  return '{' + sorted.map((k) => JSON.stringify(k) + ':' + canonicalize(val[k])).join(',') + '}';
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Compute the manifest hash for a report object. Deterministic: same
 * input → same hex string.
 */
function computeManifestHash(report) {
  return sha256Hex(canonicalize(report));
}

/**
 * Sign a report with the WARD keypair. Returns the manifest record that
 * gets embedded in PDF metadata. Never throws — signing is
 * fire-and-forget. Falls back to an ephemeral Ed25519 key with a
 * warning when no WARD keypair is available.
 */
function signReport(report, options = {}) {
  const getHookKeypair = typeof options.getHookKeypair === 'function'
    ? options.getHookKeypair
    : () => null;

  const manifest_hash = computeManifestHash(report);
  const data = Buffer.from(manifest_hash, 'utf-8');

  // Primary — persistent WARD keypair
  try {
    const kp = getHookKeypair();
    if (kp && kp.privateKey && kp.publicKey && kp.keyId) {
      const sigBuf = crypto.sign(null, data, kp.privateKey);
      const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
      const rawPub = pubDer.subarray(-32);
      return {
        manifest_hash,
        sig_type: 'ed25519',
        signature: sigBuf.toString('base64'),
        public_key: rawPub.toString('base64'),
        key_id: kp.keyId,
        signer_id: 'quox-collector',
        signed_at: new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn('[AUD-PDF/Sign] WARD keypair signing failed:', err.message);
  }

  // Fallback — ephemeral key. Verifiable only within this process lifetime.
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const sigBuf = crypto.sign(null, data, privateKey);
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    const rawPub = pubDer.subarray(-32);
    return {
      manifest_hash,
      sig_type: 'ed25519',
      signature: sigBuf.toString('base64'),
      public_key: rawPub.toString('base64'),
      key_id: 'ephemeral',
      signer_id: 'quox-collector',
      signed_at: new Date().toISOString(),
      warning: 'ephemeral_key_not_verifiable',
    };
  } catch (err) {
    console.warn('[AUD-PDF/Sign] ephemeral fallback failed:', err.message);
    return {
      manifest_hash,
      sig_type: 'none',
      signature: null,
      public_key: null,
      key_id: null,
      signer_id: 'quox-collector',
      signed_at: new Date().toISOString(),
      warning: 'unsigned',
    };
  }
}

/**
 * Verify a manifest against a fresh report. Recomputes the canonical
 * hash and verifies the Ed25519 signature.
 *
 * Returns { valid, reason? }.
 */
function verifyManifest(report, manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, reason: 'manifest missing' };
  }
  const expectedHash = computeManifestHash(report);
  if (manifest.manifest_hash !== expectedHash) {
    return { valid: false, reason: 'hash_mismatch' };
  }
  if (manifest.sig_type !== 'ed25519') {
    return { valid: false, reason: `unsupported_sig_type: ${manifest.sig_type}` };
  }
  if (!manifest.signature || !manifest.public_key) {
    return { valid: false, reason: 'missing_signature_or_key' };
  }
  try {
    // Reconstruct the public key from the raw 32-byte Ed25519 encoding.
    const rawPub = Buffer.from(manifest.public_key, 'base64');
    if (rawPub.length !== 32) return { valid: false, reason: 'invalid_public_key_length' };
    // SPKI wrapper for Ed25519: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32-byte key>
    const spki = Buffer.concat([
      Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
      rawPub,
    ]);
    const publicKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const ok = crypto.verify(
      null,
      Buffer.from(manifest.manifest_hash, 'utf-8'),
      publicKey,
      Buffer.from(manifest.signature, 'base64'),
    );
    return ok ? { valid: true } : { valid: false, reason: 'signature_verify_failed' };
  } catch (err) {
    return { valid: false, reason: `verify_error: ${err.message}` };
  }
}

/**
 * Produce the string that goes into the PDF's Keywords metadata field.
 * JSON for robust parsing. PDF readers typically truncate Keywords at
 * ~1024 chars — our payload is ~400 chars so we fit cleanly.
 */
function encodeManifestForPdf(manifest) {
  return `WARD-MANIFEST: ${JSON.stringify(manifest)}`;
}

/**
 * Extract the manifest JSON from the PDF Keywords string. Returns null
 * if the field isn't one we wrote.
 */
function decodeManifestFromPdf(keywordsString) {
  if (!keywordsString || typeof keywordsString !== 'string') return null;
  const marker = 'WARD-MANIFEST: ';
  const idx = keywordsString.indexOf(marker);
  if (idx < 0) return null;
  try {
    return JSON.parse(keywordsString.slice(idx + marker.length));
  } catch {
    return null;
  }
}

module.exports = {
  canonicalize,
  computeManifestHash,
  signReport,
  verifyManifest,
  encodeManifestForPdf,
  decodeManifestFromPdf,
};
