/**
 * telephonyIdentityStore.js: maps a verified caller phone number to a user in an
 * org, so a PIN-verified voice call can act on behalf of that user. A number is
 * never re-homed to another org. Binds its db handle at ensure(db), mirroring
 * numbersStore.js / configuredLinesStore.js. better-sqlite3.
 */

const E164 = /^\+[1-9]\d{6,14}$/;

let _db = null;

function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telephony_identity (
      number TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      label TEXT,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_telephony_identity_org ON telephony_identity(org_id);
  `);
  _db = db;
}

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function requireDb() {
  if (!_db) throw fail('store_not_initialised', 'telephony identity store not ensured');
  return _db;
}

function upsert({ number, orgId, userId, label } = {}) {
  const db = requireDb();
  if (typeof number !== 'string' || !E164.test(number)) throw fail('invalid_number');
  if (!orgId) throw fail('org_required');
  if (!userId) throw fail('user_required');
  const existing = db.prepare('SELECT org_id FROM telephony_identity WHERE number = ?').get(number);
  if (existing && existing.org_id !== orgId) throw fail('number_owned_by_other_org', 'number is bound to another org');
  db.prepare(`
    INSERT INTO telephony_identity (number, org_id, user_id, label, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(number) DO UPDATE SET
      user_id = excluded.user_id,
      label = excluded.label,
      updated_at = excluded.updated_at
  `).run(number, orgId, String(userId), label || null, Date.now());
  return { number, org_id: orgId, user_id: String(userId), label: label || null };
}

function getByNumber(number) {
  const db = requireDb();
  if (typeof number !== 'string' || !number) return null;
  const row = db.prepare('SELECT number, org_id, user_id, label FROM telephony_identity WHERE number = ?').get(number);
  return row || null;
}

function listForOrg(orgId) {
  const db = requireDb();
  if (!orgId) return [];
  return db.prepare(
    'SELECT number, user_id, label, updated_at FROM telephony_identity WHERE org_id = ? ORDER BY number'
  ).all(orgId);
}

function remove({ number, orgId } = {}) {
  const db = requireDb();
  if (!orgId) throw fail('org_required');
  return db.prepare('DELETE FROM telephony_identity WHERE number = ? AND org_id = ?').run(number, orgId).changes > 0;
}

module.exports = { ensure, upsert, getByNumber, listForOrg, remove };
