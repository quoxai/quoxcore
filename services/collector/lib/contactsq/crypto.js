'use strict';

/**
 * ContactsQ crypto envelope (contract invariants 1 and 2).
 *
 *   MASTER_ENCRYPTION_KEY --HKDF(salt 'contactsq', info 'contactsq-kek-v1')--> KEK
 *   KEK wraps a random per-contact DEK (stored as contacts.dek_wrapped)
 *   DEK AES-256-GCM encrypts every PII field of that contact
 *   blind index = HMAC-SHA256(key_org, `${channel}:${normalised}`)
 *     key_org = HKDF(master, salt 'contactsq', info `contactsq-blind-index-v1:${orgId}`)
 *
 * Nulling dek_wrapped destroys the only path to the plaintext (crypto-shred).
 * The master key is read lazily through lib/encryption.js getMasterKey().
 *
 * ROTATION: unwrapDek falls back to the KEK derived from
 * MASTER_ENCRYPTION_KEY_PREVIOUS, and rewrap.js re-wraps DEKs under the
 * current KEK. Blind indexes derive per org from the master, so a rotation
 * window uses DUAL LOOKUP (blindIndexes() returns the current and, while a
 * previous master is configured, the previous HMAC) and reindex.js re-HMACs
 * every identifier from its decrypted value. One-way suppression/tombstone
 * hashes with no surviving identifier cannot be re-keyed (reindex counts them).
 */

const nodeCrypto = require('node:crypto');
const { getMasterKey } = require('../encryption.js');

const SALT = 'contactsq';
const KEK_INFO = 'contactsq-kek-v1';
const BI_INFO_PREFIX = 'contactsq-blind-index-v1:';
const BI_VERSION = 1;

function hkdfFrom(master, info) {
  return Buffer.from(nodeCrypto.hkdfSync('sha256', master, SALT, info, 32));
}
function hkdf(info) { return hkdfFrom(getMasterKey(), info); }

function kek() { return hkdf(KEK_INFO); }

/**
 * Previous master key (dual-key rotation window, same env + semantics as the
 * auth vault), or null. Used ONLY to unwrap DEKs; never to write.
 */
function getPreviousMasterKey() {
  const raw = process.env.MASTER_ENCRYPTION_KEY_PREVIOUS;
  if (!raw) return null;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < 32) throw new Error('[SECURITY] MASTER_ENCRYPTION_KEY_PREVIOUS is too short (need 32 bytes)');
  return buf.length > 32 ? buf.subarray(0, 32) : buf;
}
function previousKeyConfigured() { return Boolean(process.env.MASTER_ENCRYPTION_KEY_PREVIOUS); }
function previousKek() {
  const m = getPreviousMasterKey();
  return m ? hkdfFrom(m, KEK_INFO) : null;
}

function blindIndexKey(orgId) {
  if (!orgId) throw new Error('blindIndexKey requires orgId');
  return hkdf(`${BI_INFO_PREFIX}${orgId}`);
}

/** Deterministic, per-org, one-way. */
function blindIndex(orgId, channel, normalised) {
  return nodeCrypto.createHmac('sha256', blindIndexKey(orgId)).update(`${channel}:${normalised}`).digest('hex');
}

/** Same derivation under the PREVIOUS master, or null outside a rotation window. */
function blindIndexPrevious(orgId, channel, normalised) {
  const prev = getPreviousMasterKey();
  if (!prev) return null;
  const key = hkdfFrom(prev, `${BI_INFO_PREFIX}${orgId}`);
  return nodeCrypto.createHmac('sha256', key).update(`${channel}:${normalised}`).digest('hex');
}

/** [current] or [current, previous]: every index a value may be stored under right now (dual lookup). */
function blindIndexes(orgId, channel, normalised) {
  const cur = blindIndex(orgId, channel, normalised);
  const prev = blindIndexPrevious(orgId, channel, normalised);
  return prev && prev !== cur ? [cur, prev] : [cur];
}

/** Non-reversible fingerprint of the org's current blind-index key (rotation detection, never the key). */
function biKeyFingerprint(orgId) {
  return nodeCrypto.createHash('sha256').update('contactsq-bi-fp:').update(blindIndexKey(orgId)).digest('hex').slice(0, 16);
}

/** Strict-names word index: HMAC(org name key, lowercased word). Exact-word search only. */
const NAME_INFO_PREFIX = 'contactsq-name-bi-v1:';
function nameIndex(orgId, word) {
  return nodeCrypto.createHmac('sha256', hkdf(`${NAME_INFO_PREFIX}${orgId}`)).update(String(word)).digest('hex');
}
function nameIndexes(orgId, word) {
  const cur = nameIndex(orgId, word);
  const prev = getPreviousMasterKey();
  if (!prev) return [cur];
  const p = nodeCrypto.createHmac('sha256', hkdfFrom(prev, `${NAME_INFO_PREFIX}${orgId}`)).update(String(word)).digest('hex');
  return p === cur ? [cur] : [cur, p];
}

/** Non-reversible short reference safe for evidence payloads. */
function biRef(blindIdx) {
  return nodeCrypto.createHash('sha256').update(String(blindIdx)).digest('hex').slice(0, 16);
}

/**
 * Envelopes. v1 = legacy, no AAD. v2 = AES-256-GCM with AAD binding the
 * ciphertext to its row/field, so a blob moved to another row, field or org
 * fails to authenticate. All new writes are v2; reads accept both.
 *   field AAD: `${orgId}|${contactId}|${field}`   (field: 'identifier:<id>', 'notes',
 *              'preferred_name', 'pronunciation', 'reason:<lease_id>', 'body')
 *   DEK   AAD: `${orgId}|${contactId}|dek`
 */
function aadOf(b, field) {
  if (!b || !b.orgId || !b.contactId) throw new Error('contactsq: binding {orgId, contactId} required');
  const f = field || b.field;
  if (!f) throw new Error('contactsq: binding field required');
  return Buffer.from(`${b.orgId}|${b.contactId}|${f}`, 'utf8');
}

function seal(key, plaintext, aad) {
  const iv = nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `v2.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

/** Test/migration helper only: produce a legacy v1 blob. */
function sealV1(key, plaintext) {
  const iv = nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

function versionOf(blob) {
  const v = String(blob || '').split('.')[0];
  return v === 'v1' || v === 'v2' ? v : null;
}

function open(key, blob, aad) {
  const parts = String(blob).split('.');
  if (parts.length !== 4 || (parts[0] !== 'v1' && parts[0] !== 'v2')) throw new Error('contactsq: bad ciphertext');
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
  if (parts[0] === 'v2') {
    if (!aad) throw new Error('contactsq: v2 ciphertext requires binding');
    d.setAAD(aad);
  }
  d.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
}

function newDek() { return nodeCrypto.randomBytes(32); }
const dekAad = (b) => aadOf(b, 'dek');
function wrapDek(dek, binding) { return seal(kek(), dek.toString('base64'), dekAad(binding)); }

/** Unwrap under the current KEK, then the previous one. Returns { dek, version, usedPrevious }. */
function unwrapDekInfo(wrapped, binding) {
  if (!wrapped) throw new Error('contactsq: contact key destroyed (shredded)');
  const aad = dekAad(binding);
  const version = versionOf(wrapped);
  try {
    return { dek: Buffer.from(open(kek(), wrapped, aad), 'base64'), version, usedPrevious: false };
  } catch (e) {
    const prev = previousKek();
    if (!prev) throw e;
    return { dek: Buffer.from(open(prev, wrapped, aad), 'base64'), version, usedPrevious: true };
  }
}
function unwrapDek(wrapped, binding) { return unwrapDekInfo(wrapped, binding).dek; }
function encryptField(dek, plaintext, binding) { return seal(dek, plaintext, aadOf(binding)); }
function decryptField(dek, blob, binding) { return open(dek, blob, versionOf(blob) === 'v2' ? aadOf(binding) : null); }

module.exports = {
  BI_VERSION, blindIndex, blindIndexPrevious, blindIndexes, biKeyFingerprint, nameIndex, nameIndexes, biRef, newDek, wrapDek, unwrapDek, unwrapDekInfo, encryptField, decryptField,
  previousKeyConfigured, versionOf, sealV1, kek,
};
