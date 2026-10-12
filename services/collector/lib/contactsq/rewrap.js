'use strict';

/**
 * ContactsQ rewrap: re-wraps every contact DEK under the CURRENT KEK with v2
 * AAD and upgrades v1 field ciphertexts to v2. Batched, idempotent, per-contact
 * transactions. Counts are per contact and DISTINCT:
 *   rewrapped       something changed for this contact
 *   already_current DEK wrapped v2 under the current KEK and every field v2
 *   shredded        dek_wrapped is NULL (nothing to rewrap; crypto-shredded)
 *   failed          could not be processed; ids reported, row left untouched
 * A failure is never silently skipped.
 *
 * NOT covered: blind indexes (derive per org from the master). TODO(ContactsQ):
 * master rotation also needs a blind-index re-HMAC (bi_version); until then the
 * API refuses to rewrap while MASTER_ENCRYPTION_KEY_PREVIOUS is set.
 */

const cx = require('./crypto.js');
const store = require('./store.js');

const BATCH = 200;
const FAILED_ID_CAP = 100;

function rewrapContact(db, c) {
  const bind = (field) => store.bindOf(c.org_id, c.id, field);
  const { dek, version, usedPrevious } = cx.unwrapDekInfo(c.dek_wrapped, { orgId: c.org_id, contactId: c.id });
  let changed = usedPrevious || version !== 'v2';
  const upgrade = (blob, field) => {
    if (!blob) return { blob, changed: false };
    if (cx.versionOf(blob) === 'v2') {
      cx.decryptField(dek, blob, bind(field)); // verify it still authenticates
      return { blob, changed: false };
    }
    return { blob: cx.encryptField(dek, cx.decryptField(dek, blob, bind(field)), bind(field)), changed: true };
  };
  db.transaction(() => {
    const cols = [['preferred_name_ct', 'preferred_name'], ['pronunciation_ct', 'pronunciation'], ['body_ciphertext', 'body']];
    for (const [col, field] of cols) {
      const u = upgrade(c[col], field);
      if (u.changed) { db.prepare(`UPDATE contacts SET ${col} = ? WHERE id = ? AND org_id = ?`).run(u.blob, c.id, c.org_id); changed = true; }
    }
    for (const i of db.prepare('SELECT id, ciphertext FROM contact_identifiers WHERE org_id = ? AND contact_id = ?').all(c.org_id, c.id)) {
      const u = upgrade(i.ciphertext, `identifier:${i.id}`);
      if (u.changed) { db.prepare('UPDATE contact_identifiers SET ciphertext = ? WHERE id = ? AND org_id = ?').run(u.blob, i.id, c.org_id); changed = true; }
    }
    for (const l of db.prepare('SELECT id, reason_ciphertext FROM contact_leases WHERE org_id = ? AND contact_id = ? AND reason_ciphertext IS NOT NULL').all(c.org_id, c.id)) {
      const u = upgrade(l.reason_ciphertext, `reason:${l.id}`);
      if (u.changed) { db.prepare('UPDATE contact_leases SET reason_ciphertext = ? WHERE id = ? AND org_id = ?').run(u.blob, l.id, c.org_id); changed = true; }
    }
    if (usedPrevious || version !== 'v2') {
      db.prepare('UPDATE contacts SET dek_wrapped = ? WHERE id = ? AND org_id = ?')
        .run(cx.wrapDek(dek, { orgId: c.org_id, contactId: c.id }), c.id, c.org_id);
    }
  })();
  return changed;
}

/** rewrapAll(orgId?) -> { rewrapped, already_current, shredded, failed, failed_ids } */
function rewrapAll(orgId) {
  const db = store.getDb();
  const counts = { rewrapped: 0, already_current: 0, shredded: 0, failed: 0 };
  const failedIds = [];
  let after = '';
  for (;;) {
    const rows = orgId
      ? db.prepare('SELECT * FROM contacts WHERE org_id = ? AND id > ? ORDER BY id LIMIT ?').all(orgId, after, BATCH)
      : db.prepare('SELECT * FROM contacts WHERE id > ? ORDER BY id LIMIT ?').all(after, BATCH);
    if (!rows.length) break;
    for (const c of rows) {
      after = c.id;
      if (!c.dek_wrapped) { counts.shredded += 1; continue; }
      try {
        if (rewrapContact(db, c)) counts.rewrapped += 1; else counts.already_current += 1;
      } catch (e) {
        counts.failed += 1;
        if (failedIds.length < FAILED_ID_CAP) failedIds.push(c.id);
      }
    }
  }
  return { ...counts, failed_ids: failedIds };
}

module.exports = { rewrapAll };
