'use strict';

/**
 * ContactsQ P6 schema (additive, idempotent, safe on a live P4 database):
 *   contacts.display_name_ct       strict_names: the real name as v2 ciphertext (binding 'display_name')
 *   contact_name_bi                strict_names: per-org HMAC of each exact name word (no phonetic keys)
 *   contactsq_bi_state             blind-index rotation bookkeeping, one row per org
 *   contact_suppressions.twin_of   previous-key twin written during a rotation window
 *   contact_tombstone_lifts        durable record of each tombstone lift (codes and a bi_ref only)
 */

function addColumnIfMissing(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function initP6(db) {
  addColumnIfMissing(db, 'contacts', 'display_name_ct', 'TEXT');
  addColumnIfMissing(db, 'contact_suppressions', 'twin_of', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_name_bi (
      contact_id  TEXT NOT NULL,
      org_id      TEXT NOT NULL,
      token       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_name_bi ON contact_name_bi(org_id, token);
    CREATE INDEX IF NOT EXISTS idx_contact_name_bi_c ON contact_name_bi(org_id, contact_id);

    CREATE TABLE IF NOT EXISTS contactsq_bi_state (
      org_id       TEXT PRIMARY KEY,
      key_fp       TEXT,
      version      INTEGER NOT NULL DEFAULT 1,
      reindexed_at TEXT,
      counts_json  TEXT
    );

    CREATE TABLE IF NOT EXISTS contact_tombstone_lifts (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL,
      channel      TEXT NOT NULL,
      bi_ref       TEXT NOT NULL,
      reason_code  TEXT NOT NULL,
      lifted_by    TEXT,
      removed      INTEGER NOT NULL,
      lifted_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_tombstone_lifts ON contact_tombstone_lifts(org_id, lifted_at);
  `);
}

module.exports = { initP6 };
