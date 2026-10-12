/**
 * qlusterDelegationSettings.js — QLUSTER-LOOP-B box-operator control.
 *
 * "Require my approval for delegated tasks" is a box-wide switch that lets the
 * box OPERATOR force every Qluster delegation onto this box's HITL inbox,
 * WITHOUT hand-authoring a GOV-4 policy. It is read by qlusterDelegate.js's
 * short-circuit (createDelegateHandler) — when true, a delegation mints an
 * inbox item and returns 202 pending_hitl BEFORE the box chat pipeline runs;
 * no LLM call happens until a human approves and the resume executor replays
 * the stored prompt. When false (default), existing behavior is unchanged —
 * the box's own L3 policy gate decides whether approval is required.
 *
 * A tiny generic key/value table (no existing settings/kv store to reuse in
 * this collector — see server.js DB init for the sibling ensure* pattern this
 * mirrors, e.g. ensureQlusterSchema in qlusterEnroll.js).
 *
 * better-sqlite3, synchronous (mirrors qlusterDelegationStore.js).
 */

const REQUIRE_APPROVAL_KEY = 'qluster_delegation_require_approval';

/**
 * Create the table if it does not exist. Called next to ensureQlusterSchema /
 * the delegation-result store's ensure() in server.js DB init.
 */
function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qluster_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at INTEGER
    );
  `);
}

/**
 * Bind the settings helpers to a db handle.
 * @param {object} db - better-sqlite3 database
 * @param {object} [opts]
 * @param {Function} [opts.now] - millisecond clock (test override)
 */
function createDelegationSettingsStore(db, { now = () => Date.now() } = {}) {
  /**
   * Default false: box-side HITL delegation stays governed purely by the
   * box's own L3 policy gate unless the operator explicitly opts in.
   */
  function getDelegationRequireApproval() {
    const row = db.prepare('SELECT value FROM qluster_settings WHERE key = ?').get(REQUIRE_APPROVAL_KEY);
    return !!row && row.value === '1';
  }

  function setDelegationRequireApproval(enabled) {
    const value = enabled ? '1' : '0';
    db.prepare(`
      INSERT INTO qluster_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(REQUIRE_APPROVAL_KEY, value, now());
    return !!enabled;
  }

  return { getDelegationRequireApproval, setDelegationRequireApproval };
}

module.exports = {
  ensure,
  createDelegationSettingsStore,
  REQUIRE_APPROVAL_KEY,
};
