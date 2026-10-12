/**
 * Signed-artifact schema family (COMMANDERQ P4) — sign / store / verify.
 *
 * Builds on the collector's EXISTING primitives (no new crypto, no new store):
 *   - signing:   the WARD Ed25519 keypair via an injected getHookKeypair(),
 *                the exact mechanism bundleSigner.signBundleManifest uses
 *                (crypto.sign(null, data, privateKey)); same fallback ladder
 *                (ephemeral ed25519 → hmac) flagged unverifiable.
 *   - canonical: bundleSigner.canonicalize (via artifactSchema), so an artifact
 *                is signed over the same canonical form VOLT bundles use.
 *   - verify:    crypto.verify against the pinned WARD public key (preferred,
 *                identity-verified) or the embedded key (self-consistent only),
 *                reusing volt-certifier.reconstructEd25519PublicKey.
 *   - store:     storeAuditEnvelope — which encrypts the payload at rest
 *                (enc:v1:) AND witnesses it in WARD automatically. We do NOT
 *                touch WARD directly (that would skip the witness fork).
 *
 * PURE by injection: every primitive comes in through ctx/opts, so the module
 * is unit-testable with fakes and carries no ward/server import. server.js wires
 * the real getHookKeypair + storeAuditEnvelope when a route creates an artifact
 * (P5 onward).
 *
 * Never throws — createArtifact returns { error } on bad input; verifyArtifact
 * returns a verdict object. An unsigned/ephemeral artifact says so honestly
 * rather than pretending to be trust-anchored (no governance theater).
 */

'use strict';

const crypto = require('crypto');
const {
  SCHEMA_VERSION,
  validateArtifact,
  artifactSignatureMessage,
  canonicalize,
} = require('./artifactSchema.js');

// Reconstruct a node KeyObject from a raw 32-byte base64 Ed25519 public key by
// prepending the fixed SPKI DER prefix. Inlined (not imported from
// volt-certifier) so this pure module carries no transitive dep — the same
// technique volt-certifier uses, minus its pkijs-heavy require chain.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function reconstructEd25519PublicKey(rawB64) {
  try {
    if (!rawB64 || typeof rawB64 !== 'string') return null;
    const raw = Buffer.from(rawB64, 'base64');
    if (raw.length !== 32) return null;
    const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signing — mirrors bundleSigner.signBundleManifest's ladder over a general
// artifact message.
// ---------------------------------------------------------------------------
async function signArtifactMessage(message, getHookKeypair) {
  const getKp = typeof getHookKeypair === 'function' ? getHookKeypair : () => null;
  const canonical = canonicalize(message);
  const data = Buffer.from(canonical, 'utf-8');

  const base = {
    sig_version: '0.1',
    signer_id: 'quox-collector',
    signed_ts: new Date().toISOString(),
    scope: 'artifact',
    message,
  };

  // Primary: persistent WARD keypair (trust-anchored, verifiable against
  // ward-pub.pem — the same anchor external verifiers use for WARD tips).
  try {
    const kp = getKp();
    if (kp && kp.privateKey && kp.publicKey && kp.keyId) {
      const sigBuf = crypto.sign(null, data, kp.privateKey);
      const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
      const rawPub = pubDer.subarray(-32);
      return {
        ...base,
        sig_type: 'ed25519',
        key_id: kp.keyId,
        signature: sigBuf.toString('base64'),
        public_key: rawPub.toString('base64'),
      };
    }
  } catch (err) {
    console.warn('[Artifact/Sign] persistent keypair signing failed:', err.message);
  }

  // Secondary: ephemeral Ed25519 (dev/test) — self-contained, NOT anchored.
  try {
    if (globalThis.crypto?.subtle) {
      const keyPair = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      const sigBuf = await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, data);
      const pubKeyBuf = await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey);
      return {
        ...base,
        sig_type: 'ed25519',
        key_id: 'artifact-ephemeral-' + Date.now().toString(36),
        signature: Buffer.from(sigBuf).toString('base64'),
        public_key: Buffer.from(pubKeyBuf).toString('base64'),
        warning: 'ephemeral_key_not_verifiable',
      };
    }
  } catch { /* fall through */ }

  // Last resort: HMAC (structurally present, cryptographically unverifiable).
  const keyBuf = crypto.randomBytes(32);
  const hmac = crypto.createHmac('sha256', keyBuf).update(data).digest();
  return {
    ...base,
    sig_type: 'hmac-sha256',
    key_id: 'artifact-ephemeral-' + Date.now().toString(36),
    signature: hmac.toString('base64'),
    public_key: null,
    warning: 'ephemeral_key_not_verifiable',
  };
}

/**
 * Build, validate, sign and (optionally) store+witness an artifact.
 *
 * @param {string} type   one of the artifact types
 * @param {object} body   the type-specific body
 * @param {object} ctx
 *   orgId, createdBy, corr, toolsUsed[], evidenceRefs[], sourceTurn
 *   getHookKeypair    {Function}  WARD keypair accessor (injected)
 *   storeAuditEnvelope{Function}  persistence+witness (injected); omit to skip storage
 *   generateId        {Function}  id minter (injected; default ULID-ish)
 *   now               {Function}  () => ISO string (injected for tests)
 * @returns {Promise<{ artifact?, stored?, signature?, error?, errors? }>}
 */
async function createArtifact(type, body, ctx = {}) {
  try {
    const now = typeof ctx.now === 'function' ? ctx.now : () => new Date().toISOString();
    const generateId = typeof ctx.generateId === 'function'
      ? ctx.generateId
      : () => `ART_${Date.now().toString(36).toUpperCase()}_${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

    const artifact = {
      artifact_id: generateId(),
      artifact_type: type,
      schema_version: SCHEMA_VERSION,
      created_at: now(),
      org_id: ctx.orgId,
      created_by: ctx.createdBy,
      corr: ctx.corr || null,
      body: body || {},
      provenance: {
        tools_used: Array.isArray(ctx.toolsUsed) ? ctx.toolsUsed : [],
        evidence_refs: Array.isArray(ctx.evidenceRefs) ? ctx.evidenceRefs : [],
        source_turn: ctx.sourceTurn || null,
      },
    };

    const { valid, errors } = validateArtifact(artifact);
    if (!valid) return { error: 'invalid_artifact', errors };

    artifact.signature = await signArtifactMessage(artifactSignatureMessage(artifact), ctx.getHookKeypair);

    let stored = false;
    if (typeof ctx.storeAuditEnvelope === 'function') {
      try {
        ctx.storeAuditEnvelope({
          type: 'event',
          from: artifact.created_by,
          to: 'system.collector',
          intent: 'quox.artifact.created',
          corr: artifact.corr,
          reply_to: null,
          org_id: artifact.org_id,
          payload: { artifact }, // encrypted at rest + WARD-witnessed by the store
        });
        stored = true;
      } catch (storeErr) {
        console.warn('[Artifact/Store] persistence failed (non-fatal):', storeErr.message);
      }
    }

    return { artifact, stored, signature: artifact.signature };
  } catch (err) {
    console.warn('[Artifact/Create] failed:', err && err.message);
    return { error: 'create_failed', errors: [err && err.message] };
  }
}

/**
 * Verify an artifact: schema valid + signature binds to CURRENT content +
 * signature bytes verify against the pinned (preferred) or embedded key.
 *
 * @param {object} artifact
 * @param {object} [opts] getHookKeypair {Function} for the pinned public key
 * @returns {{ valid, verified, signatureOk, keySource, schemaOk, reason?, warning? }}
 */
function verifyArtifact(artifact, opts = {}) {
  const schema = validateArtifact(artifact);
  const base = { valid: false, verified: false, signatureOk: false, keySource: 'none', schemaOk: schema.valid };
  if (!schema.valid) return { ...base, reason: 'invalid_schema', errors: schema.errors };

  const sig = artifact.signature;
  if (!sig || typeof sig !== 'object' || !sig.signature || !sig.message || !sig.sig_type) {
    return { ...base, reason: 'missing_signature' };
  }
  if (sig.sig_type !== 'ed25519') {
    // ephemeral/hmac fallback: structurally present, cryptographically unverifiable.
    return { ...base, reason: `unverifiable_sig_type:${sig.sig_type}`, warning: sig.warning };
  }

  // BIND: the signed message must match the message recomputed from the CURRENT
  // artifact. A mutated body/provenance changes body_hash/provenance_hash, so a
  // transplanted or tampered artifact fails here before any crypto.
  const recomputed = artifactSignatureMessage(artifact);
  if (canonicalize(recomputed) !== canonicalize(sig.message)) {
    return { ...base, verified: false, reason: 'message_not_bound_to_content' };
  }

  // Resolve verification key: pinned (identity-verified) preferred; else embedded.
  let publicKey = null;
  let keySource = 'none';
  try {
    const kp = typeof opts.getHookKeypair === 'function' ? opts.getHookKeypair() : null;
    if (kp && kp.publicKey) { publicKey = kp.publicKey; keySource = 'pinned'; }
  } catch { /* fall through to embedded */ }
  if (!publicKey && sig.public_key && typeof reconstructEd25519PublicKey === 'function') {
    publicKey = reconstructEd25519PublicKey(sig.public_key);
    if (publicKey) keySource = 'embedded';
  }
  if (!publicKey) return { ...base, reason: 'no_verification_key' };

  try {
    const data = Buffer.from(canonicalize(sig.message), 'utf-8');
    const sigBuf = Buffer.from(sig.signature, 'base64');
    const ok = crypto.verify(null, data, publicKey, sigBuf);
    // trustAnchored is the ONLY field a caller should treat as "authentic".
    // keySource==='embedded' means the signature was checked against the key
    // CARRIED IN the artifact itself — self-consistent but NOT identity-anchored:
    // anyone can mint a keypair, sign a forgery, and embed their pubkey. Only a
    // 'pinned' key (the org's WARD keypair via getHookKeypair) proves origin.
    // "Offline-verifiable / tamper-evident" holds only for trustAnchored:true.
    const trustAnchored = keySource === 'pinned';
    if (!ok) {
      return { valid: false, verified: true, signatureOk: false, keySource, trustAnchored: false, schemaOk: true, reason: 'signature_mismatch' };
    }
    return { valid: true, verified: true, signatureOk: true, keySource, trustAnchored, schemaOk: true, ...(sig.warning ? { warning: sig.warning } : {}) };
  } catch (err) {
    return { ...base, keySource, reason: `verify_error:${err && err.message}` };
  }
}

module.exports = {
  createArtifact,
  verifyArtifact,
  signArtifactMessage,
};
