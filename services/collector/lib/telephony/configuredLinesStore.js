/**
 * configuredLinesStore.js: phone lines an org has CONFIGURED at the telephony
 * bridge (pushed by the bridge), not yet bound via numbersStore. The console
 * shows these with a one-click Bind so the Numbers tab is never blank.
 *
 * Binds its db handle at ensure(db), mirroring numbersStore.js. better-sqlite3.
 */

const E164 = /^\+[1-9]\d{6,14}$/;

let _db = null;

function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telephony_configured_lines (
      number TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      label TEXT,
      source TEXT,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_telephony_configured_lines_org ON telephony_configured_lines(org_id);
  `);
  _db = db;
}

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function requireDb() {
  if (!_db) throw fail('store_not_initialised', 'configured lines store not ensured');
  return _db;
}

function upsert({ number, orgId, label, source } = {}) {
  const db = requireDb();
  if (typeof number !== 'string' || !E164.test(number)) throw fail('invalid_number');
  if (!orgId) throw fail('org_required');
  db.prepare(`
    INSERT INTO telephony_configured_lines (number, org_id, label, source, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(number) DO UPDATE SET
      org_id = excluded.org_id,
      label = excluded.label,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(number, orgId, label || null, source || null, Date.now());
  return { number, label: label || null, source: source || null };
}

function listForOrg(orgId) {
  const db = requireDb();
  if (!orgId) return [];
  return db.prepare(
    'SELECT number, label, source, updated_at FROM telephony_configured_lines WHERE org_id = ? ORDER BY number'
  ).all(orgId);
}

function remove({ number, orgId } = {}) {
  const db = requireDb();
  if (!orgId) throw fail('org_required');
  return db.prepare('DELETE FROM telephony_configured_lines WHERE number = ? AND org_id = ?').run(number, orgId).changes > 0;
}

module.exports = { ensure, upsert, listForOrg, remove };
