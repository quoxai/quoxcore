'use strict';

/**
 * ContactsQ contact photos. A photo is personal data, so it is stored like every other PII field:
 * encrypted under the contact's DEK (v2 envelope, AAD binding field 'photo'), so crypto-shredding the
 * contact makes it unreadable, and erasure also deletes the row.
 *
 *   contact_photos (org_id, contact_id) -> mime, ciphertext (base64 of the image bytes, sealed), size, updated_at
 *   contacts.photo_at                  -> ISO of the last change, or NULL. Exposed on cards as has_photo / photo_v so
 *                                        the UI knows whether to fetch, without a photo query per list row.
 *
 * Only png / jpeg / webp are accepted, decided by MAGIC BYTES (the declared content type is never trusted),
 * up to MAX_BYTES. Evidence carries ids and a format code only, never the bytes.
 */

const cx = require('./crypto.js');
const store = require('./store.js');

const MAX_BYTES = 2 * 1024 * 1024;
const FORMAT = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };

function addColumnIfMissing(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function initPhotos(db) {
  addColumnIfMissing(db, 'contacts', 'photo_at', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_photos (
      org_id      TEXT NOT NULL,
      contact_id  TEXT NOT NULL,
      mime        TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp')),
      ciphertext  TEXT NOT NULL,
      size        INTEGER NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (org_id, contact_id)
    );
  `);
}

/** Decide the image type from the first bytes; null when it is not one of the three allowed types. */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const bind = (orgId, contactId) => store.bindOf(orgId, contactId, 'photo');

/** Store (or replace) a contact's photo. -> { mime, size, updated_at } */
function putPhoto(orgId, row, buffer, mime) {
  const dek = store.dekFor(row);
  if (!dek) throw new store.ContactsqError(409, 'contact_shredded');
  const db = store.getDb();
  const at = store.nowIso();
  const ct = cx.encryptField(dek, buffer.toString('base64'), bind(orgId, row.id));
  db.transaction(() => {
    db.prepare(`
      INSERT INTO contact_photos (org_id, contact_id, mime, ciphertext, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, contact_id) DO UPDATE SET mime = excluded.mime, ciphertext = excluded.ciphertext, size = excluded.size, updated_at = excluded.updated_at
    `).run(orgId, row.id, mime, ct, buffer.length, at);
    db.prepare('UPDATE contacts SET photo_at = ?, updated_at = ? WHERE id = ? AND org_id = ?').run(at, at, row.id, orgId);
  })();
  return { mime, size: buffer.length, updated_at: at };
}

/** The decrypted photo, or null when there is none (or its key is gone). -> { mime, buffer, size, updated_at } */
function getPhoto(orgId, row) {
  const r = store.getDb().prepare('SELECT * FROM contact_photos WHERE org_id = ? AND contact_id = ?').get(orgId, row.id);
  if (!r) return null;
  const dek = store.dekFor(row);
  if (!dek) return null;
  try {
    return { mime: r.mime, buffer: Buffer.from(cx.decryptField(dek, r.ciphertext, bind(orgId, row.id)), 'base64'), size: r.size, updated_at: r.updated_at };
  } catch { return null; }
}

/** Metadata only (never the bytes), for the DSAR. */
function photoMeta(orgId, contactId) {
  const r = store.getDb().prepare('SELECT mime, size, updated_at FROM contact_photos WHERE org_id = ? AND contact_id = ?').get(orgId, contactId);
  return r ? { present: true, mime: r.mime, size_bytes: r.size, updated_at: r.updated_at } : { present: false };
}

/** Delete the photo row and clear the flag. -> true when a photo existed. Used by DELETE and by erasure. */
function deletePhoto(orgId, contactId) {
  const db = store.getDb();
  const n = db.prepare('DELETE FROM contact_photos WHERE org_id = ? AND contact_id = ?').run(orgId, contactId).changes;
  db.prepare('UPDATE contacts SET photo_at = NULL WHERE id = ? AND org_id = ?').run(contactId, orgId);
  return n > 0;
}

module.exports = { MAX_BYTES, FORMAT, initPhotos, sniff, putPhoto, getPhoto, photoMeta, deletePhoto };
