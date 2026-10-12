/**
 * EVD-2/EVD-4: VOLT bundle manifest signer.
 *
 * Extracted from server.js (2026-04-12) so the real function can be tested
 * directly rather than via a mirrored copy.
 *
 * Primary path: persistent WARD Ed25519 keypair (via getHookKeypair callback).
 * Signatures are verifiable against /var/lib/quox/ward-keys/ward-pub.pem —
 * the same trust anchor external verifiers use for WARD tips.
 *
 * Fallback paths (dev/test without WARD):
 *   - Ephemeral Ed25519 via WebCrypto (sig_type='ed25519', warning set)
 *   - HMAC-SHA256 with ephemeral key (sig_type='hmac-sha256', warning set)
 *
 * Both fallback paths flag `warning: 'ephemeral_key_not_verifiable'` so
 * downstream verifiers know the signature is self-contained only.
 */

const crypto = require('crypto');

/**
 * Canonicalize an object for deterministic signing. Sorted keys at every
 * nesting level, no whitespace. Matches VOLT SPEC §3.2 canonical form.
 */
function canonicalize(val) {
  if (val === null || val === undefined) return JSON.stringify(val);
  if (typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map(v => canonicalize(v)).join(',') + ']';
  const sorted = Object.keys(val).filter(k => val[k] !== undefined).sort();
  return '{' + sorted.map(k => JSON.stringify(k) + ':' + canonicalize(val[k])).join(',') + '}';
}

/**
 * Sign a VOLT bundle manifest.
 *
 * @param {object} manifest - { run_id, bundle_id, hash_alg?, first_event_hash, last_event_hash, event_count }
 * @param {object} [options]
 * @param {function} [options.getHookKeypair] - Returns { publicKey, privateKey, keyId } or null.
 *                                               Injected so tests can pass in known keypairs.
 * @returns {Promise<object>} Signature record (always returns; never throws)
 */
async function signBundleManifest(manifest, options = {}) {
  const getHookKeypair = typeof options.getHookKeypair === 'function'
    ? options.getHookKeypair
    : () => null;

  const message = {
    run_id: manifest.run_id,
    bundle_id: manifest.bundle_id,
    hash_alg: manifest.hash_alg || 'sha256',
    first_event_hash: manifest.first_event_hash,
    last_event_hash: manifest.last_event_hash,
    event_count: manifest.event_count,
  };

  const canonical = canonicalize(message);
  const data = Buffer.from(canonical, 'utf-8');

  // Primary: persistent WARD keypair
  try {
    const kp = getHookKeypair();
    if (kp && kp.privateKey && kp.publicKey && kp.keyId) {
      const sigBuf = crypto.sign(null, data, kp.privateKey);
      const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
      const rawPub = pubDer.subarray(-32);

      return {
        sig_version: '0.1',
        sig_type: 'ed25519',
        key_id: kp.keyId,
        signer_id: 'quox-collector',
        signed_ts: new Date().toISOString(),
        scope: 'bundle',
        message,
        signature: sigBuf.toString('base64'),
        public_key: rawPub.toString('base64'),
      };
    }
  } catch (err) {
    console.warn('[VOLT/Sign] Persistent keypair signing failed:', err.message);
    // fall through
  }

  // Secondary: ephemeral Ed25519 via WebCrypto
  try {
    if (globalThis.crypto?.subtle) {
      const keyPair = await globalThis.crypto.subtle.generateKey(
        { name: 'Ed25519' }, true, ['sign', 'verify']
      );
      const sigBuf = await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, data);
      const pubKeyBuf = await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey);

      return {
        sig_version: '0.1',
        sig_type: 'ed25519',
        key_id: 'volt-cert-ephemeral-' + Date.now().toString(36),
        signer_id: 'quox-collector',
        signed_ts: new Date().toISOString(),
        scope: 'bundle',
        message,
        signature: Buffer.from(sigBuf).toString('base64'),
        public_key: Buffer.from(pubKeyBuf).toString('base64'),
        warning: 'ephemeral_key_not_verifiable',
      };
    }
  } catch {
    // fall through
  }

  // Last-resort: HMAC-SHA256 with ephemeral key
  const keyBuf = crypto.randomBytes(32);
  const hmac = crypto.createHmac('sha256', keyBuf).update(data).digest();

  return {
    sig_version: '0.1',
    sig_type: 'hmac-sha256',
    key_id: 'volt-cert-ephemeral-' + Date.now().toString(36),
    signer_id: 'quox-collector',
    signed_ts: new Date().toISOString(),
    scope: 'bundle',
    message,
    signature: hmac.toString('base64'),
    public_key: null,
    warning: 'ephemeral_key_not_verifiable',
  };
}

module.exports = {
  signBundleManifest,
  canonicalize,
};
