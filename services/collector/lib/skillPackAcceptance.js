'use strict';

/**
 * skillPackAcceptance.js — SKILLRIGHTS #478 Phase 11, AFFIRMATIVE ACCEPTANCE
 * RECORDING. See migrations/aee/027-skill-pack-acceptances.sql for the schema
 * and test/skillPackAcceptance.test.js for the contract.
 *
 * WHY THIS EXISTS. The external audit (2026-09-11, finding 11) established
 * that distributing a skill records no assent to anything. The sync path
 * installed the pack and then returned a notice, which evidences that the
 * declared terms ACCOMPANIED the skill and nothing more. This module is the
 * missing half: an offer the actor is shown, and a record of them accepting
 * it, captured BEFORE the download is authorized.
 *
 * THE BINDING (the audit's design answer 1, implemented literally):
 *   - the authenticated PERSON (actor_user_id) and the ORG they represent;
 *   - the EXACT artefact (pack id + version + content hash);
 *   - the EXACT declared rights (sha256 over the pack's rights JSON, so a
 *     relicence invalidates the acceptance even at an unchanged content hash);
 *   - the EXACT terms document, by hash AND by preserved bytes;
 *   - a PRESENTATION VERSION (how it was put in front of them);
 *   - a SERVER timestamp;
 *   - a SINGLE-USE CHALLENGE, so one acceptance covers one offer and cannot
 *     be replayed.
 *
 * THE HONEST CLAIM, verbatim on every surface:
 *   "This authenticated actor assented to these identified terms before this
 *    download was authorized."
 * It does not prove comprehension, ownership or universal enforceability, and
 * no surface may say more than this sentence says.
 *
 * A GENERIC SYNC CREDENTIAL IS NOT ACCEPTANCE. The handlers below refuse a
 * service-key caller outright (user_assent_required): a shared machine
 * credential can prove that a process ran, never that a person agreed. The
 * delegation story ("this automation acts under an acceptance recorded
 * earlier by a named human") is deliberately NOT built here; until it is, an
 * automated sync under 'require-acceptance' is refused rather than quietly
 * treated as assent.
 *
 * APPEND-ONLY: this module contains no UPDATE or DELETE against
 * skill_pack_acceptances, and none may be added. Challenges are a different
 * matter: burning one is an UPDATE on acceptance_challenges by design.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  CORE_DEV_PACK,
  loadPackFileContents,
  computePackContentHash,
  summarizePackRights,
} = require('./skillPackInstaller.js');

// How the terms were put in front of the actor. Bump this when the
// presentation materially changes (new wording around the terms, a different
// consent surface), never for a cosmetic tweak: an acceptance record names
// this version so "what did they actually see" stays answerable.
const ACCEPTANCE_PRESENTATION_VERSION = 'quoxskills-acceptance-1.0';

const ACCEPTANCE_HONEST_CLAIM =
  'This authenticated actor assented to these identified terms before this download was authorized.';

// The limits travel with the claim, so a surface that prints one cannot print
// it without the other.
const ACCEPTANCE_CLAIM_LIMITS =
  'It does not prove comprehension, ownership or universal enforceability.';

const ACCEPTANCE_OFFER_ENDPOINT = '/api/v1/skills/acceptance/offer';
const ACCEPTANCE_RECORD_ENDPOINT = '/api/v1/skills/acceptance';
const ACCEPTANCE_INTENT = 'quox.skills.acceptance';

// services/collector/lib -> repo root.
// The terms live INSIDE the collector tree so the container image ships the
// exact bytes it hashes and serves at acceptance time (repo-root docs/ is
// not copied into the image; that gap failed closed in the first live drive).
const DEFAULT_TERMS_PATH = path.resolve(__dirname, '..', 'docs', 'QUOXSKILLS_RIGHTS_TERMS.md');
const TERMS_REF = 'services/collector/docs/QUOXSKILLS_RIGHTS_TERMS.md';

function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The canonical bytes whose hash identifies "the declared rights of this pack
 * as distributed": the same `entries` array (ref -> licence, in pack order)
 * that the installer writes into the host's .pack-rights.json and the store
 * persists as installed_rights_json. Hashing the entries rather than the whole
 * summary keeps the hash stable against presentational changes to the summary
 * shape while still changing the instant any skill's declaration changes.
 */
function canonicalRightsJson(rights) {
  const entries = (rights && rights.entries) || [];
  return JSON.stringify(entries);
}

function computeRightsSha256(rights) {
  return sha256(canonicalRightsJson(rights));
}

function readTermsBytes(termsPath = DEFAULT_TERMS_PATH) {
  try {
    return fs.readFileSync(termsPath, 'utf8');
  } catch (err) {
    // No terms, no offer. Presenting an acceptance surface without the text
    // being accepted is precisely the failure this module exists to end.
    throw fail('terms_unavailable', `Cannot read the terms document at ${termsPath}: ${err.message}`);
  }
}

function resolvePack(packId, pack) {
  const resolved = pack || CORE_DEV_PACK;
  if (packId && packId !== resolved.packId) {
    throw fail('unknown_pack', `No distributable pack '${packId}'.`);
  }
  return resolved;
}

// The recorded pack_version, or null when this process cannot name it. A
// version guessed from a different pack would be a fabricated fact on an
// append-only evidence row, so an unmatched pack id records null instead.
function resolvePackVersion(packId, pack) {
  const candidate = pack || CORE_DEV_PACK;
  return candidate && candidate.packId === packId ? (candidate.version || null) : null;
}

/**
 * Mint an OFFER: the exact thing the actor is asked to accept, plus the
 * single-use challenge that ties their acceptance to this presentation.
 *
 * Writes the challenge row. Records no acceptance: an offer is not assent.
 */
function issueOffer(db, { orgId, packId } = {}, deps = {}) {
  const {
    pack: packOverride,
    loadPack = loadPackFileContents,
    hashPack = computePackContentHash,
    termsPath = DEFAULT_TERMS_PATH,
    mintChallenge = () => crypto.randomBytes(32).toString('hex'),
  } = deps;

  if (!db) throw fail('db_unavailable', 'acceptance offer requires a database');
  if (!orgId) throw fail('invalid_offer_request', 'orgId is required');

  const pack = resolvePack(packId, packOverride);
  const files = loadPack(pack);
  const rights = summarizePackRights(files);
  const contentHash = hashPack(pack, files);
  const rightsSha256 = computeRightsSha256(rights);
  const termsBytes = readTermsBytes(termsPath);
  const termsSha256 = sha256(termsBytes);
  const challenge = mintChallenge();

  db.prepare(`
    INSERT INTO acceptance_challenges (challenge, org_id, pack_id, terms_sha256, content_hash, rights_sha256)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(challenge, orgId, pack.packId, termsSha256, contentHash, rightsSha256);

  return {
    packId: pack.packId,
    packVersion: pack.version,
    contentHash,
    rightsSha256,
    rights,
    termsSha256,
    termsBytes,
    termsRef: TERMS_REF,
    presentationVersion: ACCEPTANCE_PRESENTATION_VERSION,
    challenge,
    honestClaim: ACCEPTANCE_HONEST_CLAIM,
    claimLimits: ACCEPTANCE_CLAIM_LIMITS,
  };
}

/**
 * Record an acceptance of a previously issued offer.
 *
 * The actor must echo back EVERY hash the challenge was issued for. Any
 * difference is 'acceptance_mismatch': they would be accepting something
 * other than what was presented, and an acceptance of something other than
 * what was presented is worth nothing.
 *
 * `mintEnvelope` (optional) is called AFTER validation and BEFORE the row is
 * written, and returns an envelope id or null. That ordering is the
 * confirm-before-record pattern from POST /api/v1/skills/protect: a refused
 * acceptance never emits evidence, and a row never claims an envelope that
 * did not land.
 */
function recordAcceptance(db, { orgId, actorUserId, challenge, termsSha256, contentHash, rightsSha256 } = {}, { mintEnvelope = null, pack: packOverride = null, termsPath = DEFAULT_TERMS_PATH } = {}) {
  if (!db) throw fail('db_unavailable', 'acceptance recording requires a database');
  if (!orgId) throw fail('invalid_acceptance_request', 'orgId is required');
  if (!actorUserId) throw fail('invalid_acceptance_request', 'actorUserId is required: assent belongs to a person, not a process');
  if (!challenge) throw fail('invalid_acceptance_request', 'challenge is required');

  const row = db.prepare('SELECT * FROM acceptance_challenges WHERE challenge = ?').get(challenge);
  // An unknown challenge and another org's challenge are the same answer on
  // purpose: this endpoint must not confirm the existence of another org's
  // offer to a caller who cannot use it.
  if (!row || row.org_id !== orgId) throw fail('unknown_challenge', 'No such acceptance offer.');
  if (row.used_at) throw fail('challenge_used', 'That acceptance offer has already been used. Request a fresh one.');

  if (termsSha256 !== row.terms_sha256 || contentHash !== row.content_hash || rightsSha256 !== row.rights_sha256) {
    throw fail('acceptance_mismatch', 'The accepted terms, artefact or declared rights differ from what was offered. Request a fresh offer and accept that.');
  }

  const packVersion = resolvePackVersion(row.pack_id, packOverride);

  // The bytes as presented, preserved verbatim against the terms document
  // being edited later. Verified against the hash the challenge was issued
  // for: if the document on disk has changed since the offer, this refuses
  // rather than storing bytes the actor never saw.
  const termsBytes = readTermsBytes(termsPath);
  if (sha256(termsBytes) !== row.terms_sha256) {
    throw fail('terms_changed', 'The terms document changed after this offer was made. Request a fresh offer.');
  }

  const envelopeId = typeof mintEnvelope === 'function' ? (mintEnvelope({
    orgId,
    actorUserId,
    packId: row.pack_id,
    packVersion,
    contentHash: row.content_hash,
    rightsSha256: row.rights_sha256,
    termsSha256: row.terms_sha256,
    presentationVersion: ACCEPTANCE_PRESENTATION_VERSION,
  }) || null) : null;

  // Burn + insert in one transaction: a challenge is single-use, so the burn
  // and the acceptance it authorizes must land together or not at all. The
  // burn is conditional on used_at still being NULL, so two concurrent
  // acceptances of the same offer cannot both succeed.
  const commit = db.transaction(() => {
    const burned = db.prepare('UPDATE acceptance_challenges SET used_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE challenge = ? AND used_at IS NULL').run(challenge);
    if (burned.changes !== 1) throw fail('challenge_used', 'That acceptance offer has already been used. Request a fresh one.');
    const info = db.prepare(`
      INSERT INTO skill_pack_acceptances
        (org_id, actor_user_id, pack_id, pack_version, content_hash, rights_sha256, terms_sha256, terms_bytes, presentation_version, challenge, envelope_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orgId, actorUserId, row.pack_id, packVersion, row.content_hash, row.rights_sha256, row.terms_sha256, termsBytes, ACCEPTANCE_PRESENTATION_VERSION, challenge, envelopeId);
    return info.lastInsertRowid;
  });

  const acceptanceId = Number(commit());

  return {
    acceptanceId,
    orgId,
    actorUserId,
    packId: row.pack_id,
    packVersion,
    contentHash: row.content_hash,
    rightsSha256: row.rights_sha256,
    termsSha256: row.terms_sha256,
    presentationVersion: ACCEPTANCE_PRESENTATION_VERSION,
    envelopeId,
    honestClaim: ACCEPTANCE_HONEST_CLAIM,
    claimLimits: ACCEPTANCE_CLAIM_LIMITS,
  };
}

/**
 * Has this org accepted THIS pack at THIS exact content and THESE exact
 * declared rights? Both hashes are named in the lookup, so a new pack version
 * or a relicensed skill needs a new acceptance by construction, with no
 * expiry logic to get wrong.
 */
function hasCurrentAcceptance(db, { orgId, packId, contentHash, rightsSha256 } = {}) {
  if (!db || !orgId || !packId || !contentHash || !rightsSha256) return false;
  const row = db.prepare(`
    SELECT 1 AS ok FROM skill_pack_acceptances
    WHERE org_id = ? AND pack_id = ? AND content_hash = ? AND rights_sha256 = ?
    LIMIT 1
  `).get(orgId, packId, contentHash, rightsSha256);
  return !!row;
}

/**
 * The ledger view: who accepted what, when, and where the evidence is. The
 * preserved terms bytes are deliberately NOT included — they are evidence
 * held in the row, retrievable deliberately, not list payload duplicated into
 * every disclosure response.
 */
function listAcceptances(db, orgId) {
  if (!db || !orgId) return [];
  const rows = db.prepare(`
    SELECT id, actor_user_id, pack_id, pack_version, content_hash, rights_sha256, terms_sha256, presentation_version, envelope_id, accepted_at
    FROM skill_pack_acceptances WHERE org_id = ? ORDER BY accepted_at DESC, id DESC
  `).all(orgId);
  return rows.map((r) => ({
    id: r.id,
    actorUserId: r.actor_user_id,
    packId: r.pack_id,
    packVersion: r.pack_version || null,
    contentHash: r.content_hash,
    rightsSha256: r.rights_sha256,
    termsSha256: r.terms_sha256,
    presentationVersion: r.presentation_version,
    aeeEnvelopeId: r.envelope_id || null,
    acceptedAt: r.accepted_at,
  }));
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// A service key (req.service === true, set by requireServiceOrUserAuth for a
// raw INTERNAL_SERVICE_KEY) proves a process ran. It cannot prove a person
// agreed, so it is refused here BY NAME rather than falling through some
// generic org check that a future edit might loosen.
function requireHumanActor(req, res) {
  if (req && req.service === true) {
    res.status(403).json({
      error: 'user_assent_required',
      message: 'A service credential cannot record acceptance. Assent must be given by an authenticated user: run `quox dev skills accept <packId>` as a person.',
    });
    return null;
  }
  const actorUserId = req && req.user && req.user.id;
  const orgId = req && req.user && req.user.org_id;
  if (!actorUserId) {
    res.status(403).json({
      error: 'user_assent_required',
      message: 'An authenticated user is required: acceptance binds a person, not a credential.',
    });
    return null;
  }
  if (!orgId) {
    res.status(403).json({ error: 'org_id required' });
    return null;
  }
  return { actorUserId, orgId };
}

const ERROR_STATUS = {
  invalid_offer_request: 400,
  invalid_acceptance_request: 400,
  unknown_pack: 404,
  unknown_challenge: 404,
  challenge_used: 409,
  acceptance_mismatch: 409,
  terms_changed: 409,
  terms_unavailable: 500,
  pack_sources_unavailable: 503,
  db_unavailable: 500,
};

function respondError(res, err, logPrefix) {
  const status = ERROR_STATUS[err.code] || 500;
  if (status >= 500) console.error(logPrefix, err.code || 'unexpected', err.message);
  return res.status(status).json({ error: err.code || 'acceptance_failed', message: err.message });
}

/** GET /api/v1/skills/acceptance/offer?packId= */
function createAcceptanceOfferHandler(deps = {}) {
  const { getDb, ...offerDeps } = deps;
  return function acceptanceOfferHandler(req, res) {
    const actor = requireHumanActor(req, res);
    if (!actor) return undefined;
    let db;
    try {
      db = getDb();
    } catch (err) {
      return res.status(500).json({ error: 'db_unavailable', detail: err.message });
    }
    try {
      const offer = issueOffer(db, { orgId: actor.orgId, packId: req.query && req.query.packId }, offerDeps);
      return res.json(offer);
    } catch (err) {
      return respondError(res, err, '[skills-acceptance][offer]');
    }
  };
}

/**
 * POST /api/v1/skills/acceptance
 *
 * Confirm-before-record, same shape as POST /api/v1/skills/protect: the
 * envelope is minted after the acceptance validates and before the row is
 * written, and its id is stored only once the envelope is confirmed landed.
 * The evidence envelope carries the HASHES, never the terms bytes: the bytes
 * live in the acceptance row, and the evidence chain is not a document store.
 */
function createAcceptanceRecordHandler(deps = {}) {
  const {
    getDb,
    emitEnvelope = null,
    generateEnvelopeId = null,
    envelopeLanded = null,
    pack = null,
    termsPath = DEFAULT_TERMS_PATH,
  } = deps;

  return function acceptanceRecordHandler(req, res) {
    const actor = requireHumanActor(req, res);
    if (!actor) return undefined;
    let db;
    try {
      db = getDb();
    } catch (err) {
      return res.status(500).json({ error: 'db_unavailable', detail: err.message });
    }

    const body = req.body || {};
    const mintEnvelope = (typeof emitEnvelope === 'function' && typeof generateEnvelopeId === 'function')
      ? (facts) => {
        try {
          const envelopeId = generateEnvelopeId();
          emitEnvelope({
            id: envelopeId,
            type: 'evidence',
            from: `human.${facts.actorUserId}`,
            to: 'skills.distribution',
            intent: ACCEPTANCE_INTENT,
            corr: facts.packId,
            payload: {
              org_id: facts.orgId,
              actor_user_id: facts.actorUserId,
              pack_id: facts.packId,
              pack_version: facts.packVersion,
              content_hash: facts.contentHash,
              rights_sha256: facts.rightsSha256,
              terms_sha256: facts.termsSha256,
              presentation_version: facts.presentationVersion,
            },
          });
          if (typeof envelopeLanded === 'function' && !envelopeLanded(envelopeId)) {
            console.warn('[skills-acceptance] evidence envelope did not land (transcript storage disabled?); acceptance stored without an AEE reference');
            return null;
          }
          return envelopeId;
        } catch (err) {
          // Evidence must never break the thing it witnesses, and a row must
          // never claim an envelope that was not written.
          console.warn('[skills-acceptance] evidence envelope failed:', err.message);
          return null;
        }
      }
      : null;

    try {
      const result = recordAcceptance(db, {
        orgId: actor.orgId,
        actorUserId: actor.actorUserId,
        challenge: body.challenge,
        termsSha256: body.termsSha256,
        contentHash: body.contentHash,
        rightsSha256: body.rightsSha256,
      }, { mintEnvelope, pack, termsPath });
      return res.status(201).json(result);
    } catch (err) {
      return respondError(res, err, '[skills-acceptance][record]');
    }
  };
}

module.exports = {
  ACCEPTANCE_PRESENTATION_VERSION,
  ACCEPTANCE_HONEST_CLAIM,
  ACCEPTANCE_CLAIM_LIMITS,
  ACCEPTANCE_OFFER_ENDPOINT,
  ACCEPTANCE_RECORD_ENDPOINT,
  ACCEPTANCE_INTENT,
  DEFAULT_TERMS_PATH,
  TERMS_REF,
  canonicalRightsJson,
  computeRightsSha256,
  issueOffer,
  recordAcceptance,
  hasCurrentAcceptance,
  listAcceptances,
  createAcceptanceOfferHandler,
  createAcceptanceRecordHandler,
};
