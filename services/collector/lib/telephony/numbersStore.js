/**
 * numbersStore.js — per-number telephony org binding (quox#695).
 *
 * Replaces the single env var QUOX_TELEPHONY_ORG_ID: each phone number (E.164)
 * is bound to exactly one org, so inbound calls/SMS to a number resolve to the
 * owning org instead of one instance-wide org. A number is GLOBALLY unique and
 * is never silently re-homed: upserting a number owned by a different org
 * fails with code 'number_owned_by_other_org' (otherwise one tenant could
 * hijack another's inbound traffic by claiming its number).
 *
 * Binds its db handle at ensure(db) (single collector process / single aeeDb),
 * mirroring toolApprovalStore.js. better-sqlite3, synchronous.
 */

const E164 = /^\+[1-9]\d{6,14}$/;

let _db = null;

function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telephony_numbers (
      number TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      label TEXT,
      policy_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_telephony_numbers_org ON telephony_numbers(org_id);
  `);
  _db = db;
}

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function requireDb() {
  if (!_db) throw fail('store_not_initialised', 'telephony numbers store not ensured');
  return _db;
}

function isValidNumber(n) {
  return typeof n === 'string' && E164.test(n);
}

function rowToNumber(r) {
  if (!r) return null;
  let policy = {};
  try { policy = JSON.parse(r.policy_json || '{}'); } catch (_e) { policy = {}; }
  return {
    number: r.number,
    org_id: r.org_id,
    label: r.label || null,
    policy,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function getNumber(number) {
  const db = requireDb();
  return rowToNumber(db.prepare('SELECT * FROM telephony_numbers WHERE number = ?').get(number));
}

function listForOrg(orgId) {
  const db = requireDb();
  return db
    .prepare('SELECT * FROM telephony_numbers WHERE org_id = ? ORDER BY number')
    .all(orgId)
    .map(rowToNumber);
}

function upsertNumber({ number, orgId, label, policy } = {}) {
  const db = requireDb();
  if (!isValidNumber(number)) throw fail('invalid_number', 'number must be E.164 (+<country><digits>)');
  if (!orgId || typeof orgId !== 'string') throw fail('org_required', 'orgId required');
  if (policy !== undefined && (policy === null || typeof policy !== 'object' || Array.isArray(policy))) {
    throw fail('invalid_policy', 'policy must be a JSON object');
  }
  const now = Date.now();
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM telephony_numbers WHERE number = ?').get(number);
    if (existing && existing.org_id !== orgId) {
      throw fail('number_owned_by_other_org', 'number is bound to another org');
    }
    if (!existing) {
      db.prepare(
        'INSERT INTO telephony_numbers (number, org_id, label, policy_json, created_at, updated_at) VALUES (?,?,?,?,?,?)'
      ).run(number, orgId, label == null ? null : String(label).slice(0, 200), JSON.stringify(policy || {}), now, now);
    } else {
      // Omitted fields keep their current value (PUT {label} must not wipe policy).
      db.prepare('UPDATE telephony_numbers SET label = ?, policy_json = ?, updated_at = ? WHERE number = ? AND org_id = ?').run(
        label === undefined ? existing.label : (label === null ? null : String(label).slice(0, 200)),
        policy === undefined ? existing.policy_json : JSON.stringify(policy),
        now, number, orgId
      );
    }
  });
  tx();
  return getNumber(number);
}

function removeNumber({ number, orgId } = {}) {
  const db = requireDb();
  if (!orgId) return false;
  return db.prepare('DELETE FROM telephony_numbers WHERE number = ? AND org_id = ?').run(number, orgId).changes > 0;
}

module.exports = { ensure, isValidNumber, upsertNumber, getNumber, listForOrg, removeNumber };
