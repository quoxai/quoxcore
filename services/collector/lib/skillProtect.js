'use strict';

/**
 * SKILLRIGHTS #478 Phase 10 — `quox skills protect` (moat 1).
 *
 * The governed counterpart of the open `skillrights register` verb. The CLI
 * hashes the skill locally and sends ONLY the SkillRights manifest (per-file
 * SHA-256s + metadata): skill content never reaches the collector, matching
 * the open standard's privacy stance. This module then:
 *
 *   1. re-derives the manifest hash from the manifest core (integrity);
 *   2. has the org sign a DOMAIN-SEPARATED digest of it via the auth-side
 *      org signing oracle (POST /api/internal/crystals/sign — auth is a pure
 *      Ed25519 oracle over opaque sha256 digests; the CSK is the org's
 *      signing identity for skill-domain artefacts, and the domain prefix
 *      below keeps skill-protection signatures unmixable with crystal
 *      signatures), and VERIFIES that answer over the expected digest before
 *      building anything on it (verifyOrgSignature);
 *   3. registers the manifest hash in the OPEN SkillRights registry
 *      (consuming the open format, never forking it) and verifies the
 *      returned receipt (RFC 6962 inclusion proof + Ed25519 tree head)
 *      BEFORE accepting it, then binds that receipt to THIS request field for
 *      field (receiptBindingMismatch): a valid receipt for somebody else's
 *      registration is not evidence of ours;
 *   4. persists the protection row (full receipt included, so the org can
 *      prove the registration offline) — the caller then emits the AEE
 *      envelope whose WARD witness anchors it in the org evidence chain.
 *
 * What a protection proves and does not prove is the registry's binding
 * text: existence-by-time, signer claim, chronology. NEVER legal ownership.
 *
 * The registry base URL comes from env only (SKILLRIGHTS_REGISTRY_URL) —
 * never from the request body — so this path cannot be steered into SSRF.
 */

const { createHash, createPublicKey, verify: edVerify } = require('node:crypto');

const PROTECT_DOMAIN = 'skillrights-protect-v1';
const DEFAULT_REGISTRY_URL = 'https://registry.skillrights.org';
const SHA256_RE = /^[a-f0-9]{64}$/;
const MODES = new Set(['private', 'public']);

// --- canonical JSON + hashing (MUST stay in sync with the open
// skillrights CLI's lib/hash.js — the manifest hash is the shared format) --

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    // Null-prototype object + defineProperty, NOT `{}` + assignment.
    // `sorted.__proto__ = x` on an ordinary object sets the PROTOTYPE instead
    // of creating an own property, so a `__proto__` member of a signed record
    // silently vanished from the hashed bytes while the store kept it: adding
    // `"__proto__":{"owner":"..."}` inside an already-signed record left every
    // verifier green (ASTRA audit round 3, finding 2). Every allowed JSON
    // property is now preserved as an own, enumerable property, which
    // JSON.stringify serialises.
    const sorted = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(sorted, key, {
        value: canonicalize(value[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return sorted;
  }
  return value;
}

function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

// --- RFC 6962 receipt verification (in sync with registry/lib/merkle.js
// and the open CLI's lib/receipt.js — deliberate duplication: a receipt
// must be verifiable with no shared dependency) ---------------------------

function sha(...bufs) {
  const h = createHash('sha256');
  for (const b of bufs) h.update(b);
  return h.digest();
}

// Largest power of two strictly less than n (RFC 6962 split point).
function splitPoint(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

// The side each sibling must sit on, derived from (index, size) alone. The
// sides carried in the proof are NOT trusted: without this the claimed leaf
// index is decorative, and a receipt could misstate its position in the log
// while still verifying. See skillrights registry/lib/merkle.js.
function expectedSides(index, size) {
  const sides = [];
  let i = index;
  let n = size;
  while (n > 1) {
    const k = splitPoint(n);
    if (i < k) { sides.push('right'); n = k; }
    else { sides.push('left'); i -= k; n -= k; }
  }
  return sides.reverse();
}

function verifyInclusion(leaf, index, size, proof, rootHex) {
  if (!Number.isInteger(index) || !Number.isInteger(size)) return false;
  if (index < 0 || index >= size) return false;
  // Strict schema BEFORE any cryptography, identical to the one the open
  // skillrights CLI and registry apply (ASTRA audit round 3, finding 15):
  // a real array, never an array-like `{"0":step,"length":1}`, and every
  // sibling exactly 64 lowercase hex characters. Buffer.from(hex, 'hex')
  // truncates silently at the first invalid character, so an unchecked
  // sibling of `<64 hex>zz` used to be accepted as if it were valid.
  if (typeof rootHex !== 'string' || !SHA256_RE.test(rootHex)) return false;
  const sides = expectedSides(index, size);
  if (!Array.isArray(proof) || proof.length !== sides.length) return false;
  for (const step of proof) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
    if (typeof step.hash !== 'string' || !SHA256_RE.test(step.hash)) return false;
  }
  let current = leaf;
  for (let step = 0; step < proof.length; step += 1) {
    if (proof[step].side !== sides[step]) return false;
    const sibling = Buffer.from(proof[step].hash, 'hex');
    if (sides[step] === 'right') current = sha(Buffer.from([1]), current, sibling);
    else current = sha(Buffer.from([1]), sibling, current);
  }
  return current.equals(Buffer.from(rootHex, 'hex'));
}

function verifyReceiptBundle(bundle) {
  try {
    const receipt = bundle.receipt;
    const publicKeyPem = bundle.logKey && bundle.logKey.publicKeyPem;
    if (!receipt || !publicKeyPem) return { ok: false, reason: 'bundle missing receipt or logKey' };

    // The key id MUST be derived from the bundled public key, never taken
    // from the bundle's own claim. Echoing the claimed id let a forged bundle
    // (attacker key, fabricated record, any date) display the REAL registry's
    // key id, so the documented authenticity check passed on a fabrication.
    // Found by audit 2026-09-10. Derivation matches registry/lib/store.js.
    const derivedKeyId = sha256Hex(publicKeyPem).slice(0, 16);
    if (bundle.logKey.keyId && bundle.logKey.keyId !== derivedKeyId) {
      return { ok: false, reason: `logKey.keyId claims ${bundle.logKey.keyId} but the bundled public key is ${derivedKeyId}` };
    }
    if (receipt.treeHead && receipt.treeHead.keyId && receipt.treeHead.keyId !== derivedKeyId) {
      return { ok: false, reason: 'tree head keyId does not match the bundled public key' };
    }
    // The top-level srid is not covered by any hash; the record's is.
    if (receipt.srid && receipt.record && receipt.srid !== receipt.record.srid) {
      return { ok: false, reason: 'receipt srid does not match the signed record srid' };
    }
    const leaf = sha(Buffer.from([0]), Buffer.from(canonicalJSON(receipt.record)));
    const { size, root, ts, signature } = receipt.treeHead;
    // The record's own seq is inside the hashed bytes; leafIndex is not. If
    // they disagree, the receipt is misstating its position in the log.
    if (typeof receipt.record.seq === 'number' && receipt.record.seq !== receipt.leafIndex) {
      return { ok: false, reason: 'leafIndex does not match the record sequence number' };
    }
    if (!verifyInclusion(leaf, receipt.leafIndex, size, receipt.inclusionProof, root)) {
      return { ok: false, reason: 'inclusion proof does not reach the tree head root' };
    }
    const headBytes = Buffer.from(canonicalJSON({ size, root, ts }));
    if (!edVerify(null, headBytes, publicKeyPem, Buffer.from(signature, 'base64'))) {
      return { ok: false, reason: 'tree head signature invalid for the bundled log key' };
    }
    // Report the DERIVED id, never the bundle's claim.
    return { ok: true, keyId: derivedKeyId };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// --- request validation ---------------------------------------------------

function buildProtectDigest(manifestSha256) {
  return sha256Hex(`${PROTECT_DOMAIN}\0${manifestSha256}`);
}

// --- org signing oracle response validation ------------------------------

const ED25519_SIG_RE = /^[0-9a-f]{128}$/;   // 64 bytes, hex
const ED25519_PUB_RE = /^[0-9a-f]{64}$/;    // 32 bytes, hex (raw, not SPKI)
// The SPKI DER prefix for an Ed25519 public key, so a raw 32-byte key can be
// turned into something node:crypto will verify with.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verifies the auth-side oracle's answer before anything is built on it.
 * The oracle used to be trusted on its word: a response of
 * `signature: "not-even-hex"` was stored and registered as an org signature
 * (ASTRA audit round 3, finding 3).
 *
 * Two checks, in order: the SHAPE (128 hex characters of signature, 64 of
 * public key, so a truncated or textual answer never reaches the crypto), then
 * the SIGNATURE ITSELF over the exact digest we asked to have signed, against
 * the very key the oracle returned. The second check is the one that matters:
 * shape alone cannot tell a good signature from a real signature over some
 * other message.
 *
 * Returns { ok, reason }.
 */
function verifyOrgSignature(signed, expectedDigestHex) {
  if (!signed || typeof signed !== 'object') return { ok: false, reason: 'oracle response was not an object' };
  if (typeof signed.signature !== 'string' || !ED25519_SIG_RE.test(signed.signature)) {
    return { ok: false, reason: 'oracle signature is not 128 lowercase hex characters' };
  }
  if (typeof signed.public_key_hex !== 'string' || !ED25519_PUB_RE.test(signed.public_key_hex)) {
    return { ok: false, reason: 'oracle public key is not 64 lowercase hex characters' };
  }
  try {
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(signed.public_key_hex, 'hex')]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const ok = edVerify(
      null,
      Buffer.from(expectedDigestHex, 'hex'),
      key,
      Buffer.from(signed.signature, 'hex'),
    );
    if (!ok) return { ok: false, reason: 'oracle signature does not verify over the protect digest' };
  } catch (err) {
    return { ok: false, reason: `oracle key could not be used: ${err.message}` };
  }
  return { ok: true, reason: null };
}

// --- receipt/request binding ---------------------------------------------

/**
 * The receipt must describe THE REGISTRATION WE JUST MADE, field for field.
 * verifyReceiptBundle() only establishes that a receipt is internally
 * consistent and signed by the log; it says nothing about WHICH registration
 * it is for. Without this comparison a genuine receipt for hash A, public
 * mode and an unrelated signer could be stored beside a row claiming hash B
 * and private mode (ASTRA audit round 3, finding 3).
 *
 * Absence is compared too: a field we submitted that the record does not carry
 * is a mismatch, as is a field the record carries that we never sent.
 *
 * Returns null when everything matches, or a reason string.
 */
function receiptBindingMismatch(record, { manifestSha256, mode, regBody }) {
  if (!record || typeof record !== 'object') return 'receipt carries no record';
  const artifact = record.artifact;
  if (!artifact || typeof artifact !== 'object') return 'record carries no artifact';
  if (artifact.algorithm !== 'sha256') return 'record artifact algorithm is not sha256';
  if (artifact.sha256 !== manifestSha256) return 'record artifact hash is not the manifest we registered';
  if (record.mode !== mode) return 'record mode is not the mode we requested';

  for (const field of ['license', 'author', 'publicKey', 'signature', 'supersedes', 'meta']) {
    const sent = regBody[field];
    const got = record[field];
    if (sent === undefined) {
      if (got !== undefined) return `record carries a ${field} we never submitted`;
      continue;
    }
    if (got === undefined) return `record is missing the ${field} we submitted`;
    if (canonicalJSON(sent) !== canonicalJSON(got)) return `record ${field} is not the one we submitted`;
  }
  return null;
}

/**
 * Validates the protect request body and re-derives the manifest hash.
 * Returns { ok, errors, manifestSha256 }.
 */
function validateProtectRequest(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be a JSON object'] };
  const m = body.manifest;
  if (!m || typeof m !== 'object') {
    errors.push('manifest is required');
    return { ok: false, errors };
  }
  if (m.version !== 1) errors.push('manifest.version must be 1');
  if (typeof m.created !== 'string') errors.push('manifest.created must be a string');
  if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files) || Object.keys(m.files).length === 0) {
    errors.push('manifest.files must be a non-empty object');
  } else {
    for (const [rel, h] of Object.entries(m.files)) {
      if (typeof h !== 'string' || !SHA256_RE.test(h)) {
        errors.push(`manifest.files['${rel}'] must be a lowercase hex sha256`);
        break;
      }
    }
  }
  if (typeof m.manifestSha256 !== 'string' || !SHA256_RE.test(m.manifestSha256)) {
    errors.push('manifest.manifestSha256 must be a lowercase hex sha256');
  }
  const mode = body.mode === undefined ? 'private' : body.mode;
  if (!MODES.has(mode)) errors.push("mode must be 'private' or 'public'");
  if (body.supersedes !== undefined && (typeof body.supersedes !== 'string' || !SHA256_RE.test(body.supersedes))) {
    errors.push('supersedes must be a lowercase hex sha256');
  }
  if (errors.length) return { ok: false, errors };

  // Integrity: the manifest hash must be re-derivable from the core, the
  // exact algorithm the open CLI uses (canonical JSON of the core fields).
  const core = {
    version: 1,
    created: m.created,
    identifier: m.identifier || null,
    author: m.author || null,
    files: m.files,
  };
  const derived = sha256Hex(canonicalJSON(core));
  if (derived !== m.manifestSha256) {
    return { ok: false, errors: [`manifest.manifestSha256 does not match the manifest core (derived ${derived})`] };
  }
  return { ok: true, errors: [], manifestSha256: derived, mode };
}

// --- orchestration --------------------------------------------------------

/**
 * Protect a skill for an org. deps:
 *   db                  better-sqlite3 handle (aee.db, migrations applied)
 *   fetchFn             fetch-compatible (injected for tests)
 *   authBaseUrl         e.g. http://auth:3101
 *   internalServiceKey  X-Service-Key value for the auth signing oracle
 *   registryUrl         open registry base (env-derived, never request-derived)
 *
 * Returns { created, protection } where protection is the stored row shape.
 * Throws coded errors: invalid_protect_request | org_signing_failed |
 * registry_registration_failed | receipt_verification_failed.
 */
async function protectSkill({ orgId, body }, deps) {
  const {
    db,
    fetchFn = fetch,
    authBaseUrl,
    internalServiceKey,
    registryUrl = process.env.SKILLRIGHTS_REGISTRY_URL || DEFAULT_REGISTRY_URL,
  } = deps;

  const v = validateProtectRequest(body);
  if (!v.ok) {
    const err = new Error(v.errors.join('; '));
    err.code = 'invalid_protect_request';
    err.errors = v.errors;
    throw err;
  }
  const { manifestSha256, mode } = v;
  const m = body.manifest;

  // Idempotency: same org + same content = the existing protection.
  const existing = db
    .prepare('SELECT * FROM skill_protections WHERE org_id = ? AND manifest_sha256 = ?')
    .get(orgId, manifestSha256);
  if (existing) {
    return { created: false, protection: rowToProtection(existing) };
  }

  // 1. Org signature over the domain-separated digest (auth-side oracle;
  //    private key never leaves auth).
  const protectDigest = buildProtectDigest(manifestSha256);
  let signed;
  try {
    const res = await fetchFn(`${authBaseUrl}/api/internal/crystals/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-key': internalServiceKey },
      body: JSON.stringify({ org_id: orgId, hash: protectDigest }),
    });
    if (!res.ok) throw new Error(`auth signing oracle returned ${res.status}`);
    signed = await res.json();
    if (!signed || !signed.signature || !signed.public_key_hex) throw new Error('oracle response missing signature');
    // An oracle answer is not evidence until it verifies (finding 3).
    const sigCheck = verifyOrgSignature(signed, protectDigest);
    if (!sigCheck.ok) throw new Error(sigCheck.reason);
  } catch (err) {
    const e = new Error(`org signing failed: ${err.message}`);
    e.code = 'org_signing_failed';
    throw e;
  }

  // 2. Open-registry registration. The org key is recorded in the registry's
  //    free-text evidence fields, self-describing about its format.
  const regBody = {
    hash: manifestSha256,
    mode,
    publicKey: `ed25519:${signed.public_key_hex}`,
    signature: `skillrights-protect-v1:ed25519:${signed.signature}`,
  };
  if (m.identifier) regBody.license = m.identifier;
  if (m.author) regBody.author = m.author;
  if (body.supersedes) regBody.supersedes = body.supersedes;
  if (mode === 'public' && body.meta && typeof body.meta === 'object') {
    const meta = {};
    if (typeof body.meta.name === 'string') meta.name = body.meta.name;
    if (typeof body.meta.description === 'string') meta.description = body.meta.description;
    if (typeof body.meta.repository === 'string') meta.repository = body.meta.repository;
    if (Object.keys(meta).length) regBody.meta = meta;
  }

  let receipt;
  let logKey;
  try {
    const base = registryUrl.replace(/\/$/, '');
    const res = await fetchFn(`${base}/api/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(regBody),
    });
    if (res.status !== 201) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()); } catch { /* non-JSON */ }
      throw new Error(`registry returned ${res.status} ${detail}`.trim());
    }
    receipt = (await res.json()).receipt;
    const keyRes = await fetchFn(`${base}/api/v1/log/key`);
    if (!keyRes.ok) throw new Error(`registry key endpoint returned ${keyRes.status}`);
    logKey = await keyRes.json();
  } catch (err) {
    const e = new Error(`registry registration failed: ${err.message}`);
    e.code = 'registry_registration_failed';
    throw e;
  }

  // 3. Verify the receipt BEFORE accepting it (a receipt that does not
  //    verify is not evidence).
  const bundle = { receipt, logKey };
  const check = verifyReceiptBundle(bundle);
  if (!check.ok) {
    const e = new Error(`registry receipt failed verification: ${check.reason}`);
    e.code = 'receipt_verification_failed';
    throw e;
  }

  // 3b. A VALID receipt is not necessarily OUR receipt. Bind it to the exact
  //     registration this call made before a single field is persisted.
  const mismatch = receiptBindingMismatch(receipt.record, { manifestSha256, mode, regBody });
  if (mismatch) {
    const e = new Error(`registry receipt does not match this registration: ${mismatch}`);
    e.code = 'receipt_mismatch';
    throw e;
  }

  // 4. Persist. The caller emits the AEE envelope (with WARD witness) and
  //    records its id via recordEnvelopeId().
  const info = db.prepare(`
    INSERT INTO skill_protections
      (org_id, srid, skill_name, manifest_sha256, license, mode, org_key_id,
       org_signature_hex, org_public_key_hex, protect_digest, registry_url,
       receipt_json, supersedes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orgId,
    receipt.record.srid,
    (body.meta && body.meta.name) || null,
    manifestSha256,
    m.identifier || null,
    mode,
    signed.key_id || null,
    signed.signature,
    signed.public_key_hex,
    protectDigest,
    registryUrl,
    JSON.stringify(bundle),
    body.supersedes || null,
  );
  const row = db.prepare('SELECT * FROM skill_protections WHERE id = ?').get(info.lastInsertRowid);
  return { created: true, protection: rowToProtection(row) };
}

function recordEnvelopeId(db, id, envelopeId) {
  db.prepare('UPDATE skill_protections SET aee_envelope_id = ? WHERE id = ?').run(envelopeId, id);
}

function listProtections(db, orgId) {
  return db
    .prepare('SELECT * FROM skill_protections WHERE org_id = ? ORDER BY created_at DESC, id DESC')
    .all(orgId)
    .map(rowToProtection);
}

function rowToProtection(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    srid: row.srid,
    skillName: row.skill_name,
    manifestSha256: row.manifest_sha256,
    license: row.license,
    mode: row.mode,
    orgKeyId: row.org_key_id,
    orgSignatureHex: row.org_signature_hex,
    orgPublicKeyHex: row.org_public_key_hex,
    protectDigest: row.protect_digest,
    registryUrl: row.registry_url,
    receipt: JSON.parse(row.receipt_json),
    supersedes: row.supersedes,
    aeeEnvelopeId: row.aee_envelope_id,
    createdAt: row.created_at,
  };
}

module.exports = {
  PROTECT_DOMAIN,
  DEFAULT_REGISTRY_URL,
  canonicalJSON,
  sha256Hex,
  buildProtectDigest,
  validateProtectRequest,
  verifyReceiptBundle,
  verifyOrgSignature,
  receiptBindingMismatch,
  protectSkill,
  recordEnvelopeId,
  listProtections,
};
