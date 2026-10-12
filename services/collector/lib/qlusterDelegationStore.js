/**
 * qlusterDelegationStore.js — Track B (QLUSTER-LOOP-B) result store.
 *
 * Durable, server-side state for a RESUMABLE delegated chat. When a Qluster
 * delegation trips the box's L3 HITL gate, the delegation path (qlusterDelegate)
 * mints an inbox item and writes a `pending_hitl` row here keyed by `corr`.
 * When a human approves/denies that inbox item, the auth service calls the
 * collector's internal resume endpoint, which:
 *   1. claimForResume(corr) — a CONDITIONAL update that flips pending_hitl →
 *      resuming and returns the row-change count. This is the idempotency lock:
 *      a second concurrent (or duplicated) resume sees 0 changes and no-ops, so
 *      a granted approval can never be replayed to run the prompt twice.
 *   2. replays the STORED prompt through the box chat pipeline with the grant.
 *   3. finalize(corr, ...) — records the terminal status + reply/reason.
 *
 * The row is also read back by `corr` via the signed retrieval endpoint. corr
 * is semi-guessable, so cross-controller reads are guarded by org-scope at the
 * endpoint — NOT by corr secrecy.
 *
 * better-sqlite3, synchronous (mirrors qlusterEnroll.js).
 */

const VALID_STATUSES = new Set([
  'pending_hitl',
  'resuming',
  'completed',
  'denied_hitl',
  'box_exec_failed',
  'error',
]);

/**
 * Create the table if it does not exist. Called next to ensureQlusterSchema.
 */
function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qluster_delegation_results (
      corr            TEXT PRIMARY KEY,
      org_id          TEXT,
      controller_id   TEXT,
      selected_agent  TEXT,
      prompt          TEXT,
      inbox_item_id   TEXT,
      status          TEXT NOT NULL DEFAULT 'pending_hitl',
      reply           TEXT,
      reason          TEXT,
      layer           TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_qdel_results_org ON qluster_delegation_results(org_id);
  `);
}

/**
 * Bind the store helpers to a db handle.
 * @param {object} db - better-sqlite3 database
 * @param {object} [opts]
 * @param {Function} [opts.now] - millisecond clock (test override)
 */
function createDelegationStore(db, { now = () => Date.now() } = {}) {
  /**
   * Insert (or refresh) a pending_hitl row for a delegation awaiting approval.
   */
  function putPending({ corr, org_id, controller_id, selected_agent, prompt, inbox_item_id }) {
    if (!corr) throw new Error('putPending requires corr');
    const t = now();
    db.prepare(`
      INSERT INTO qluster_delegation_results
        (corr, org_id, controller_id, selected_agent, prompt, inbox_item_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending_hitl', ?, ?)
      ON CONFLICT(corr) DO UPDATE SET
        org_id         = excluded.org_id,
        controller_id  = excluded.controller_id,
        selected_agent = excluded.selected_agent,
        prompt         = excluded.prompt,
        inbox_item_id  = excluded.inbox_item_id,
        status         = 'pending_hitl',
        updated_at     = excluded.updated_at
    `).run(
      corr,
      org_id || null,
      controller_id || null,
      selected_agent || null,
      prompt || null,
      inbox_item_id || null,
      t,
      t
    );
    return getByCorr(corr);
  }

  /**
   * The idempotency lock. Conditionally flip pending_hitl → resuming. Returns
   * the number of rows changed: 1 on the FIRST claim, 0 on any later claim (row
   * already resuming/terminal, or unknown corr). The resume executor MUST call
   * this first and bail when it returns 0.
   */
  function claimForResume(corr) {
    const info = db.prepare(`
      UPDATE qluster_delegation_results
      SET status = 'resuming', updated_at = ?
      WHERE corr = ? AND status = 'pending_hitl'
    `).run(now(), corr);
    return info.changes;
  }

  /**
   * Record a terminal outcome for a delegation.
   */
  function finalize(corr, { status, reply = null, reason = null, layer = null } = {}) {
    if (!VALID_STATUSES.has(status)) {
      throw new Error(`finalize: invalid status '${status}'`);
    }
    const info = db.prepare(`
      UPDATE qluster_delegation_results
      SET status = ?, reply = ?, reason = ?, layer = ?, updated_at = ?
      WHERE corr = ?
    `).run(status, reply, reason, layer, now(), corr);
    return info.changes;
  }

  function getByCorr(corr) {
    return db.prepare('SELECT * FROM qluster_delegation_results WHERE corr = ?').get(corr) || null;
  }

  return { putPending, claimForResume, finalize, getByCorr };
}

module.exports = {
  ensure,
  createDelegationStore,
  VALID_STATUSES,
};
