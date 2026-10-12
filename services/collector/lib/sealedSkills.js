'use strict';

/**
 * SKILLRIGHTS #478 Phase 14: the sealed skill STORE and invocation
 * orchestration (docs/SEALED_EXECUTION_PILOT_DESIGN.md).
 *
 * The sealed tier's whole claim, stated exactly as the design doc pins it and
 * never stronger:
 *
 *   "Sealed execution keeps the text of your methodology out of the calling
 *    model's context; the executing model and its provider do see it, under
 *    that provider's data terms, and nothing here prevents someone who can
 *    call the capability from learning what it does."
 *
 * SUPERSEDED 2026-09-11 (external audit): the original wording claimed the
 * text stays out of "every model's context and every provider's training
 * pipeline", which the execution path contradicts (lib/sealedExecutor.js
 * sends the plaintext to the executing model).
 *
 * So this module is built around one rule: the plaintext leaves here in
 * exactly one direction, into lib/sealedExecutor.js, and never into a
 * response, a log line, an error message or an evidence envelope. Everything
 * a caller can read back is a MANIFEST (name, description, input contract,
 * content hash). Everything the evidence chain carries is a HASH.
 *
 * Encryption: AES-256-GCM, fresh 12-byte IV per encryption, stored as
 * 'v2:' + iv:authTag:ciphertext (base64-joined), with org|sealedId|contentHash
 * as ADDITIONAL AUTHENTICATED DATA, and the plaintext hash re-checked on every
 * read. Decryption FAILS CLOSED (throws 'sealed_decrypt_failed') on a tampered
 * blob, the wrong key, or a ciphertext belonging to a DIFFERENT skill: a
 * sealed skill that cannot be decrypted correctly must never run, because a
 * silent fallback here would run SOMETHING and call it the org's methodology.
 * Legacy v1 blobs (no prefix, no AAD) decrypt once and are rewritten as v2 in
 * place (readRowContent / migrateSealedBlobs).
 *
 * The key is passed IN as a parameter and is never read from env by this
 * module. Callers read process.env.SEALED_CONTENT_KEY. That is deliberate:
 * it keeps the library testable with obvious fake keys, and it keeps the one
 * env read at the route boundary where the 503 "sealed_unavailable" decision
 * is made. Per the design doc, SEALED_CONTENT_KEY is its OWN key with its own
 * purpose: never the org crystal signing key, never any other existing secret.
 */

const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto');
const { generateUlid } = require('./imageStore.js');

const ENC_ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_RE = /^[a-f0-9]{64}$/i;
// Blob format marker. v1 (no prefix) is AES-GCM with NO additional
// authenticated data: authenticated bytes, unbound identity. v2 binds
// org|sealedId|contentSha256 into the tag. See buildSealedAad.
const BLOB_V2_PREFIX = 'v2:';
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_NAME_LEN = 200;
// 'pending' is a RESERVATION held by a run in flight (see reserveInvocation).
// It becomes one of the other four when the run settles.
const INVOCATION_STATUSES = new Set(['ok', 'error', 'refused_overlap', 'timeout', 'pending']);

// Twice lib/sealedExecutor.js's DEFAULT_TIMEOUT_MS. Not imported: the executor
// is the caller's dependency here, and this module stays pure of it.
const PENDING_STALE_MS = 240000;

// Default org-wide ceiling, matching SEALED_INVOKE_ORG_RATE_PER_HOUR's
// registered default in lib/platformCapabilities.js.
const DEFAULT_ORG_RATE_PER_HOUR = 100;

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function isValidContentKey(key) {
  return typeof key === 'string' && KEY_RE.test(key);
}

function keyBuffer(key) {
  if (!isValidContentKey(key)) {
    // The message never echoes the value, only its shape.
    throw coded('sealed_key_invalid', 'sealed content key must be 64 hex characters');
  }
  return Buffer.from(key, 'hex');
}

/**
 * The additional authenticated data that BINDS a ciphertext to the one skill
 * it belongs to: org, sealed id, and the hash of the plaintext it must be.
 * Without it, AES-GCM authenticates the bytes but says nothing about WHOSE
 * bytes they are, so swapping two ciphertext cells made one skill execute
 * another's methodology under the first one's manifest and evidence hash
 * (ASTRA audit round 3, finding 13).
 */
function buildSealedAad(orgId, sealedId, contentSha256) {
  return `${orgId}|${sealedId}|${contentSha256}`;
}

/**
 * Encrypts the methodology for storage. Returns 'v2:' + iv:authTag:ciphertext
 * (base64), with `aad` bound into the GCM tag.
 *
 * The version prefix exists so a v1 blob (no prefix, no AAD) is recognisable
 * on sight and can be upgraded rather than guessed at.
 */
function encryptContent(plaintext, key, aad = '') {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ENC_ALGO, keyBuffer(key), iv);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return BLOB_V2_PREFIX + [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ct.toString('base64'),
  ].join(':');
}

function isV2Blob(blob) {
  return String(blob).startsWith(BLOB_V2_PREFIX);
}

/**
 * Decrypts a stored blob. FAILS CLOSED: every failure mode (malformed blob,
 * tampered ciphertext, tampered tag, wrong key, WRONG SKILL) raises the same
 * generic 'sealed_decrypt_failed' with no detail, so the error itself is not
 * an oracle and carries no content.
 *
 * A v1 blob (no version prefix) carries no AAD and is decrypted without one:
 * that path exists only so the row can be rewritten as v2 (see
 * upgradeLegacyBlob / migrateSealedBlobs). Passing an AAD for a v1 blob is not
 * an error and not a silent downgrade either, because the caller checks the
 * plaintext hash afterwards.
 */
function decryptContent(blob, key, aad = '') {
  try {
    const raw = String(blob);
    const v2 = isV2Blob(raw);
    const parts = (v2 ? raw.slice(BLOB_V2_PREFIX.length) : raw).split(':');
    if (parts.length !== 3) throw new Error('shape');
    const [ivB64, tagB64, ctB64] = parts;
    const decipher = createDecipheriv(ENC_ALGO, keyBuffer(key), Buffer.from(ivB64, 'base64'));
    if (v2) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err && err.code === 'sealed_key_invalid') throw err;
    throw coded('sealed_decrypt_failed', 'sealed content could not be decrypted');
  }
}

/**
 * Reads one row's plaintext, whatever blob version it holds, and refuses
 * anything that is not exactly the methodology the row claims:
 *
 *   - a v2 blob must authenticate under this row's AAD (org, sealed id,
 *     content hash);
 *   - EVERY blob's plaintext must hash to the row's content_sha256, so a
 *     ciphertext re-encrypted under the right AAD by someone holding the key
 *     still cannot substitute different text;
 *   - a v1 blob that passes the hash check is rewritten as v2 in place, so a
 *     legacy row is unbound exactly once and never again.
 *
 * Throws 'sealed_decrypt_failed' on every failure, with no detail.
 */
function readRowContent(db, row, key) {
  const aad = buildSealedAad(row.org_id, row.sealed_id, row.content_sha256);
  const legacy = !isV2Blob(row.content_ciphertext);
  const plaintext = decryptContent(row.content_ciphertext, key, aad);
  if (sha256Hex(plaintext) !== row.content_sha256) {
    throw coded('sealed_decrypt_failed', 'sealed content could not be decrypted');
  }
  if (legacy && db) {
    db.prepare('UPDATE sealed_skills SET content_ciphertext = ? WHERE id = ?')
      .run(encryptContent(plaintext, key, aad), row.id);
  }
  return plaintext;
}

/**
 * Rewrites every legacy v1 blob as a v2 blob bound to its skill identity.
 * Idempotent, and deliberately conservative: a row that cannot be decrypted or
 * whose plaintext does not match its stored hash is LEFT EXACTLY AS IT IS and
 * counted as failed, because replacing it would destroy the only copy of
 * whatever it holds. Returns { scanned, upgraded, failed }.
 */
function migrateSealedBlobs(db, key) {
  const rows = db.prepare(
    `SELECT * FROM sealed_skills WHERE content_ciphertext NOT LIKE '${BLOB_V2_PREFIX}%'`,
  ).all();
  let upgraded = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      readRowContent(db, row, key);
      upgraded += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: rows.length, upgraded, failed };
}

// --- manifests -------------------------------------------------------------

/**
 * The ONLY shape a caller ever reads back. Deliberately built field by field
 * from the row rather than by deleting fields off a spread, so a column added
 * to sealed_skills later cannot silently start appearing in responses.
 */
function rowToManifest(row) {
  let inputContract = null;
  if (row.input_contract) {
    try { inputContract = JSON.parse(row.input_contract); } catch { inputContract = null; }
  }
  return {
    sealedId: row.sealed_id,
    name: row.name,
    description: row.description,
    inputContract,
    contentSha256: row.content_sha256,
    createdAt: row.created_at,
  };
}

function validateCreate({ orgId, name, description, inputContract, content }) {
  const errors = [];
  if (!orgId || typeof orgId !== 'string') errors.push('orgId is required');
  if (typeof name !== 'string' || !name.trim()) errors.push('name must be a non-empty string');
  else if (name.length > MAX_NAME_LEN) errors.push(`name must be <= ${MAX_NAME_LEN} characters`);
  if (description !== undefined && description !== null && typeof description !== 'string') {
    errors.push('description must be a string');
  }
  if (inputContract !== undefined && inputContract !== null
    && (typeof inputContract !== 'object' || Array.isArray(inputContract))) {
    errors.push('inputContract must be a JSON object');
  }
  if (typeof content !== 'string' || !content.trim()) errors.push('content must be a non-empty string');
  return errors;
}

/**
 * Seals a skill for an org. Returns the MANIFEST ONLY: never the plaintext,
 * never the ciphertext. Throws 'invalid_sealed_skill' (with .errors) or
 * 'sealed_name_taken'.
 */
function createSealedSkill(db, { orgId, name, description, inputContract, content, createdBy, key }) {
  const errors = validateCreate({ orgId, name, description, inputContract, content });
  if (errors.length) {
    const err = coded('invalid_sealed_skill', errors.join('; '));
    err.errors = errors;
    throw err;
  }
  const sealedId = generateUlid();
  const contentSha256 = sha256Hex(content);
  // Bound to THIS org, THIS sealed id and THIS content hash, so the row cannot
  // be swapped for another skill's ciphertext (audit finding 13).
  const ciphertext = encryptContent(content, key, buildSealedAad(orgId, sealedId, contentSha256)); // validates the key too
  try {
    db.prepare(`
      INSERT INTO sealed_skills
        (org_id, sealed_id, name, description, input_contract, content_ciphertext, content_sha256, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orgId,
      sealedId,
      name.trim(),
      description || null,
      inputContract ? JSON.stringify(inputContract) : null,
      ciphertext,
      contentSha256,
      createdBy || null,
    );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw coded('sealed_name_taken', 'a sealed skill with that name already exists in this org');
    }
    throw err;
  }
  const row = db.prepare('SELECT * FROM sealed_skills WHERE sealed_id = ?').get(sealedId);
  return rowToManifest(row);
}

function listSealedSkills(db, orgId) {
  return db
    .prepare('SELECT * FROM sealed_skills WHERE org_id = ? ORDER BY created_at DESC, id DESC')
    .all(orgId)
    .map(rowToManifest);
}

function getManifest(db, orgId, sealedId) {
  const row = db.prepare('SELECT * FROM sealed_skills WHERE org_id = ? AND sealed_id = ?').get(orgId, sealedId);
  return row ? rowToManifest(row) : null;
}

/**
 * The one function that yields plaintext. Org-scoped, and used by the invoke
 * path only: no route returns its result to a caller, directly or indirectly.
 */
function getDecryptedContent(db, orgId, sealedId, key) {
  const row = db.prepare('SELECT * FROM sealed_skills WHERE org_id = ? AND sealed_id = ?').get(orgId, sealedId);
  if (!row) throw coded('sealed_not_found', 'sealed skill not found for this org');
  return readRowContent(db, row, key);
}

// --- invocation accounting -------------------------------------------------

function countRecentInvocations(db, orgId, sealedId, sinceIso) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM sealed_invocations
    WHERE org_id = ? AND sealed_id = ? AND created_at >= ?
  `).get(orgId, sealedId, sinceIso).n;
}

function countRecentOrgInvocations(db, orgId, sinceIso) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM sealed_invocations
    WHERE org_id = ? AND created_at >= ?
  `).get(orgId, sinceIso).n;
}

/**
 * Reserves capacity for ONE invocation, or refuses. ASTRA audit round 3,
 * finding 9: usage used to be checked before the run and recorded after it,
 * with an await in between, so N concurrent calls under a limit of 1 all
 * passed. Both counts and the INSERT now happen inside one synchronous
 * better-sqlite3 transaction, called before invokeSealed's first await, so
 * there is no window for a second call to read a stale count.
 *
 * The reserved row carries status 'pending' and is counted like any other, so
 * calls in flight consume quota. finaliseInvocation() writes its outcome.
 *
 * Stale pending rows are swept first. A pending row is a RESERVATION, not a
 * witnessed invocation: it never received an envelope id, an output hash or a
 * duration, so a process that died mid-run left no evidence either way.
 * Holding an org's hourly quota hostage to a crash is the worse failure, so
 * reservations older than PENDING_STALE_MS are deleted rather than counted
 * forever. Rows that DID settle are never touched.
 *
 * Returns { ok: true, id } or { ok: false, scope: 'skill'|'org', limit }.
 */
function reserveInvocation(db, {
  orgId, sealedId, inputSha256, ratePerHour, orgRatePerHour, sinceIso, staleIso,
}) {
  const run = db.transaction(() => {
    db.prepare("DELETE FROM sealed_invocations WHERE status = 'pending' AND created_at < ?").run(staleIso);

    const skillUsed = countRecentInvocations(db, orgId, sealedId, sinceIso);
    if (skillUsed >= ratePerHour) return { ok: false, scope: 'skill', limit: ratePerHour };

    const orgUsed = countRecentOrgInvocations(db, orgId, sinceIso);
    if (orgUsed >= orgRatePerHour) return { ok: false, scope: 'org', limit: orgRatePerHour };

    const info = db.prepare(`
      INSERT INTO sealed_invocations (org_id, sealed_id, status, input_sha256)
      VALUES (?, ?, 'pending', ?)
    `).run(orgId, sealedId, inputSha256);
    return { ok: true, id: info.lastInsertRowid };
  });
  return run();
}

/** Writes the outcome onto a reservation made by reserveInvocation(). */
function finaliseInvocation(db, id, { status, outputSha256, durationMs, envelopeId }) {
  if (!INVOCATION_STATUSES.has(status) || status === 'pending') {
    throw coded('invalid_invocation_status', `unknown sealed invocation status: ${status}`);
  }
  db.prepare(`
    UPDATE sealed_invocations
       SET status = ?, output_sha256 = ?, duration_ms = ?, envelope_id = ?
     WHERE id = ?
  `).run(status, outputSha256 || null, durationMs ?? null, envelopeId || null, id);
}

/**
 * Hashes only, by construction: there is no column here that could hold the
 * input, the output or the methodology. createdAt is injectable for tests
 * (production always takes the column default).
 */
function recordInvocation(db, { orgId, sealedId, status, inputSha256, outputSha256, durationMs, envelopeId, createdAt }) {
  if (!INVOCATION_STATUSES.has(status)) {
    throw coded('invalid_invocation_status', `unknown sealed invocation status: ${status}`);
  }
  const info = createdAt
    ? db.prepare(`
        INSERT INTO sealed_invocations
          (org_id, sealed_id, status, input_sha256, output_sha256, duration_ms, envelope_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(orgId, sealedId, status, inputSha256, outputSha256 || null, durationMs ?? null, envelopeId || null, createdAt)
    : db.prepare(`
        INSERT INTO sealed_invocations
          (org_id, sealed_id, status, input_sha256, output_sha256, duration_ms, envelope_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(orgId, sealedId, status, inputSha256, outputSha256 || null, durationMs ?? null, envelopeId || null);
  return info.lastInsertRowid;
}

/** Caller input contract: a non-empty string, 32KB ceiling. */
function validateInvokeInput(input) {
  if (typeof input !== 'string') return { ok: false, error: 'input must be a string' };
  if (!input.trim()) return { ok: false, error: 'input must not be empty' };
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) return { ok: false, error: 'input must be <= 32KB' };
  return { ok: true };
}

// --- orchestration ---------------------------------------------------------

/**
 * One sealed invocation, end to end. The HTTP route is a thin wrapper over
 * this (auth, validation, status mapping). The behaviour that actually has to
 * hold lives here so it can be tested: every outcome except a rate-limit
 * refusal writes BOTH a sealed_invocations row and an AEE evidence envelope,
 * and the envelope carries hashes only.
 *
 * deps:
 *   db, key                content key (the caller read it from env)
 *   runInvocation          async ({content, input}) -> {refused, output, outputSha256, durationMs}
 *                          throws coded executor_error | executor_timeout
 *   ratePerHour            resolved org setting (SEALED_INVOKE_RATE_PER_HOUR)
 *   generateEnvelopeId     mint an envelope id (server.js's)
 *   emitEnvelope           store it (storeAuditEnvelope)
 *   confirmEnvelope        (id) -> truthy iff the envelope row actually landed
 *
 * Returns a discriminated outcome: rate_limited | not_found | ok | refused |
 * error. Never returns the methodology, and never returns the output on a
 * refusal.
 */
async function invokeSealed({ orgId, sealedId, input, userId }, deps) {
  const {
    db,
    key,
    runInvocation,
    ratePerHour = 30,
    orgRatePerHour = DEFAULT_ORG_RATE_PER_HOUR,
    pendingStaleMs = PENDING_STALE_MS,
    generateEnvelopeId,
    emitEnvelope,
    confirmEnvelope,
    now = () => new Date(),
  } = deps;

  const manifest = getManifest(db, orgId, sealedId);
  if (!manifest) return { outcome: 'not_found' };

  const inputSha256 = sha256Hex(input);

  // RESERVE BEFORE THE FIRST AWAIT. Everything from here to the reservation is
  // synchronous, so an interleaved call cannot see a stale count (ASTRA audit
  // round 3, finding 9). Rate limiting stays a cloning MITIGATION, never a
  // prevention (design doc, leakage table); a refused-before-running call is
  // not an invocation, so it writes no row and no envelope.
  const reservation = reserveInvocation(db, {
    orgId,
    sealedId,
    inputSha256,
    ratePerHour,
    orgRatePerHour,
    sinceIso: new Date(now().getTime() - 3600_000).toISOString(),
    staleIso: new Date(now().getTime() - pendingStaleMs).toISOString(),
  });
  if (!reservation.ok) {
    return { outcome: 'rate_limited', scope: reservation.scope, limit: reservation.limit };
  }

  let status;
  let outputSha256 = null;
  let durationMs = null;
  let result = null;
  let failure = null;

  // A decrypt failure IS a failed invocation and must be witnessed like one
  // (design doc: witnessed on every call including failures). It gets its own
  // code so a key/storage problem is never mistaken for an executor fault.
  // (Adversarial review finding, 2026-09-11.)
  let content = null;
  try {
    content = getDecryptedContent(db, orgId, sealedId, key);
  } catch (err) {
    if (err.code === 'sealed_decrypt_failed' || err.code === 'sealed_key_invalid') {
      failure = 'sealed_decrypt_failed';
      status = 'error';
    } else {
      // An unexpected fault still settles the reservation: a row left pending
      // by a throw would sit in the limiter until the sweep window passes.
      finaliseInvocation(db, reservation.id, { status: 'error', durationMs: null, envelopeId: null });
      throw err;
    }
  }

  if (!failure) {
    try {
      result = await runInvocation({ content, input });
      durationMs = result.durationMs ?? null;
      outputSha256 = result.outputSha256 || null;
      status = result.refused ? 'refused_overlap' : 'ok';
    } catch (err) {
      // Generic by construction: err.code is one of two values and its message
      // never carries content (see lib/sealedExecutor.js).
      failure = err.code === 'executor_timeout' ? 'executor_timeout' : 'executor_error';
      status = failure === 'executor_timeout' ? 'timeout' : 'error';
      durationMs = err.durationMs ?? null;
    }
  }

  // Evidence. Mint the id first so the invocation row can point at it, then
  // confirm the envelope actually landed BEFORE recording the reference:
  // emitEnvelope can silently skip (an org with transcript storage disabled),
  // and an invocation must never claim an evidence envelope that does not
  // exist. Same confirm-before-record discipline as /api/v1/skills/protect.
  const envelopeId = generateEnvelopeId();
  emitEnvelope({
    id: envelopeId,
    type: 'evidence',
    from: `human.${userId || 'unknown'}`,
    to: 'skills.sealed',
    intent: 'quox.skills.sealed.invoke',
    corr: sealedId,
    payload: {
      org_id: orgId,
      sealed_id: sealedId,
      status,
      input_sha256: inputSha256,
      output_sha256: outputSha256,
      duration_ms: durationMs,
      content_sha256: manifest.contentSha256,
    },
  });
  const landedId = confirmEnvelope(envelopeId) ? envelopeId : null;

  // The reservation made before the run becomes the durable record of it.
  finaliseInvocation(db, reservation.id, { status, outputSha256, durationMs, envelopeId: landedId });

  const evidence = { envelopeId: landedId, inputSha256, outputSha256, durationMs };
  if (failure) return { outcome: 'error', code: failure, evidence };
  if (status === 'refused_overlap') return { outcome: 'refused', evidence };
  return { outcome: 'ok', output: result.output, evidence };
}

module.exports = {
  MAX_INPUT_BYTES,
  PENDING_STALE_MS,
  DEFAULT_ORG_RATE_PER_HOUR,
  sha256Hex,
  isValidContentKey,
  buildSealedAad,
  encryptContent,
  decryptContent,
  migrateSealedBlobs,
  createSealedSkill,
  listSealedSkills,
  getManifest,
  getDecryptedContent,
  countRecentInvocations,
  countRecentOrgInvocations,
  reserveInvocation,
  finaliseInvocation,
  recordInvocation,
  validateInvokeInput,
  invokeSealed,
};
