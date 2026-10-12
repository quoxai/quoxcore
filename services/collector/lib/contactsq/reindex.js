'use strict';

/**
 * ContactsQ blind-index reindex (master-key rotation, part 2 of 2; rewrap.js is part 1).
 *
 * Recomputes every blind index under the CURRENT master, with bi_version advanced:
 *   identifiers      value decrypted (DEK unwrap falls back to MASTER_ENCRYPTION_KEY_PREVIOUS),
 *                    re-normalised, re-HMAC'd (value + canonical twin)
 *   suppressions     one-way hashes. A suppression is converted ONLY when a surviving identifier
 *                    proves its value (the identifier's value is hashed under BOTH keys and the
 *                    suppression rows matching either are moved to the current key). Previous-key
 *                    twins written during the window are dropped. Anything else written under the
 *                    previous key (a DNC for a number with no contact, a tombstone of an erased
 *                    contact) CANNOT be inverted: it is counted as suppressions_unconvertible and
 *                    keeps matching only while MASTER_ENCRYPTION_KEY_PREVIOUS stays configured.
 *   name tokens      strict_names contacts: words re-HMAC'd from the decrypted name
 *
 * Per-contact transactions, idempotent, counts DISTINCT (reindexed / already_current / shredded /
 * failed). Completion (state row) is written only when nothing failed. Never logs a value.
 */

const cx = require('./crypto.js');
const store = require('./store.js');
const biState = require('./biState.js');
const strictNames = require('./strictNames.js');
const { normalizeIdentifier } = require('./normalize.js');

const BATCH = 200;
const CAP = 100;

const ph = (l) => l.map(() => '?').join(',');
const uniq = (l) => [...new Set(l.filter(Boolean))];

function reindexContact(db, orgId, c, target, counts) {
  const dek = cx.unwrapDek(c.dek_wrapped, { orgId, contactId: c.id });
  db.transaction(() => {
    for (const i of db.prepare('SELECT * FROM contact_identifiers WHERE org_id = ? AND contact_id = ?').all(orgId, c.id)) {
      const value = cx.decryptField(dek, i.ciphertext, store.bindOf(orgId, c.id, `identifier:${i.id}`));
      const norm = normalizeIdentifier(i.channel, value);
      const curBi = cx.blindIndex(orgId, i.channel, norm.normalised);
      const curCanon = cx.blindIndex(orgId, i.channel, norm.canonical);
      // Suppressions this identifier proves, under either key generation.
      const hashes = uniq([
        ...cx.blindIndexes(orgId, i.channel, norm.normalised), ...cx.blindIndexes(orgId, i.channel, norm.canonical),
        i.blind_index, i.blind_index_canonical,
      ]);
      const moved = db.prepare(
        `UPDATE contact_suppressions SET blind_index = ?, blind_index_canonical = ?, bi_version = ?
           WHERE org_id = ? AND channel = ? AND twin_of IS NULL AND bi_version < ?
             AND blind_index IN (${ph(hashes)})`
      ).run(curBi, curCanon, target, orgId, i.channel, target, ...hashes).changes;
      counts.suppressions_reindexed += moved;
      if (i.blind_index !== curBi || i.blind_index_canonical !== curCanon || i.bi_version !== target) {
        db.prepare('UPDATE contact_identifiers SET blind_index = ?, blind_index_canonical = ?, bi_version = ? WHERE id = ? AND org_id = ?')
          .run(curBi, curCanon, target, i.id, orgId);
        counts.identifiers_reindexed += 1;
      } else counts.identifiers_already_current += 1;
    }
    if (c.display_name_ct) {
      const name = strictNames.searchTextFor(orgId, c, dek);
      const want = strictNames.blindTokensFor(orgId, name);
      const have = db.prepare('SELECT token FROM contact_name_bi WHERE org_id = ? AND contact_id = ?').all(orgId, c.id).map((r) => r.token);
      if (have.length !== want.length || !want.every((t) => have.includes(t))) {
        strictNames.writeBlindTokens(db, orgId, c.id, name);
        counts.name_contacts_reindexed += 1;
      }
    }
  })();
}

/** reindexOrg(orgId) -> { counts, failed_ids, complete, previous_key_removable } */
function reindexOrg(orgId) {
  if (!orgId) throw new Error('reindexOrg requires orgId');
  const db = store.getDb();
  const st = biState.getState(db, orgId);
  const fp = cx.biKeyFingerprint(orgId);
  const already = Boolean(st && st.key_fp === fp);
  const target = already ? st.version : ((st && st.version) || 1) + 1;
  const counts = {
    contacts_reindexed: 0, contacts_already_current: 0, contacts_shredded: 0, contacts_failed: 0,
    identifiers_reindexed: 0, identifiers_already_current: 0, suppressions_reindexed: 0,
    name_contacts_reindexed: 0, suppression_twins_dropped: 0, suppressions_unconvertible: 0,
  };
  const failedIds = [];
  let after = '';
  for (;;) {
    const rows = db.prepare("SELECT * FROM contacts WHERE org_id = ? AND id > ? AND status != 'erased' ORDER BY id LIMIT ?").all(orgId, after, BATCH);
    if (!rows.length) break;
    for (const c of rows) {
      after = c.id;
      if (!c.dek_wrapped) { counts.contacts_shredded += 1; continue; }
      const before = counts.identifiers_reindexed + counts.name_contacts_reindexed;
      try {
        reindexContact(db, orgId, c, target, counts);
        if (counts.identifiers_reindexed + counts.name_contacts_reindexed > before) counts.contacts_reindexed += 1;
        else counts.contacts_already_current += 1;
      } catch (e) {
        counts.contacts_failed += 1;
        if (failedIds.length < CAP) failedIds.push(c.id);
      }
    }
  }
  if (counts.contacts_failed === 0) {
    counts.suppression_twins_dropped = db.prepare('DELETE FROM contact_suppressions WHERE org_id = ? AND twin_of IS NOT NULL').run(orgId).changes;
    counts.suppressions_unconvertible = db.prepare('SELECT COUNT(*) AS n FROM contact_suppressions WHERE org_id = ? AND bi_version < ?').get(orgId, target).n;
    db.prepare(`
      INSERT INTO contactsq_bi_state (org_id, key_fp, version, reindexed_at, counts_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(org_id) DO UPDATE SET key_fp = excluded.key_fp, version = excluded.version,
        reindexed_at = excluded.reindexed_at, counts_json = excluded.counts_json
    `).run(orgId, fp, target, store.nowIso(), JSON.stringify({ suppressions_unconvertible: counts.suppressions_unconvertible }));
  }
  const complete = counts.contacts_failed === 0;
  return { bi_version: target, counts, failed_ids: failedIds, complete, previous_key_removable: complete && counts.suppressions_unconvertible === 0 };
}

/** Rewrap helper: has the org's blind index been rotated, and is anything still tied to the previous key? */
function status(orgId) {
  const db = store.getDb();
  const st = biState.getState(db, orgId);
  let unconvertible = 0;
  if (st && st.counts_json) { try { unconvertible = JSON.parse(st.counts_json).suppressions_unconvertible || 0; } catch { unconvertible = 0; } }
  return { complete: biState.reindexComplete(db, orgId), suppressions_unconvertible: unconvertible };
}

module.exports = { reindexOrg, status };
