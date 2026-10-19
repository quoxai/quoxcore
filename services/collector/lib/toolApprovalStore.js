/**
 * toolApprovalStore.js — HITL approve→execute bridge (native tool approvals).
 *
 * Durable, server-side state for a gated native tool call (proxmox_vm_action,
 * docker_fleet_container_action, ...) that tripped `withApprovalGate`
 * (approvalGate.js). Today that gate returns `pending` with an `approvalId`
 * but nothing re-executes on human approval. This store + toolResume.js
 * close that loop, mirroring the PROVEN QLUSTER-LOOP-B idiom
 * (qlusterDelegationStore.js / qlusterDelegate.js):
 *
 *   1. createApprovalRequest (approvalGate.js) mints a crypto-random
 *      `resume_token` and writes a `pending` row here keyed by approval_id,
 *      alongside the STRIPPED tool input (no `_approvalId`/`_resumeToken`
 *      keys) needed to replay the exact call.
 *   2. A human resolves the inbox item minted alongside it. The auth service
 *      posts to the collector's internal resume endpoint (toolResume.js),
 *      which:
 *        a. claimForResume(approval_id) — a CONDITIONAL update that flips
 *           pending → resuming. This is the idempotency lock: a second
 *           concurrent/duplicated resume sees no rows changed and no-ops, so
 *           an approval can never be replayed to execute twice.
 *        b. re-executes the stored tool call carrying
 *           {_approvalId, _resumeToken: row.resume_token} so
 *           withApprovalGate's token-verified branch runs it directly.
 *        c. finalize(approval_id, ...) records the terminal outcome.
 *
 * SECURITY: resume_token is a crypto-random secret
 * (crypto.randomBytes(24).toString('hex')). It is stored ONLY in this table,
 * NEVER returned to any client/LLM/HTTP response, and is read ONLY by the
 * service-key-gated internal resume endpoint (toolResume.js) and the
 * withApprovalGate token-verification branch it feeds. Presence of
 * `_approvalId`/`_resumeToken` on a tool input is NOT sufficient to execute —
 * the token must match the stored row via verifyToken().
 *
 * better-sqlite3, synchronous (mirrors qlusterDelegationStore.js). Unlike
 * that module's `createDelegationStore(db)` factory, this store binds its db
 * handle at `ensure(db)` time and exposes flat module functions — callers
 * (approvalGate.js, toolResume.js) `require('./toolApprovalStore.js')` and
 * call the methods directly, matching the single-collector-process /
 * single-aeeDb topology (there is only ever one db handle to bind).
 */

const VALID_STATUSES = new Set([
  'pending',
  'resuming',
  'approved',
  'denied',
  'error',
  'expired', // QUOXTRUST T-AUTH (FND_..SRMA): a claimed approval past its TTL, refused at resume
]);

// Statuses that verifyToken() considers "still executable". `resuming` is
// included deliberately: the real caller of verifyToken is
// withApprovalGate's token-verified branch, invoked by toolResume.js's
// resume handler AFTER claimForResume() has already flipped the row to
// `resuming` (the idempotency lock runs first, before the tool is
// re-executed). `pending` covers a not-yet-claimed row (defensive); `denied`
// and `error` are excluded — never executable.
const VERIFIABLE_STATUSES = new Set(['pending', 'resuming', 'approved']);

let _db = null;

/**
 * Create the table if it does not exist, and bind the db handle used by all
 * other exports. Called next to qlusterDelegationStore's ensure() in
 * server.js, with the SAME aeeDb handle.
 */
function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_approvals (
      approval_id   TEXT PRIMARY KEY,
      org_id        TEXT,
      agent_id      TEXT,
      user_id       TEXT,
      tool_name     TEXT NOT NULL,
      input_json    TEXT,
      resume_token  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      result_json   TEXT,
      conversation_id TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_approvals_org ON tool_approvals(org_id);
  `);
  // QUOXHAT #657 (H1): the approval-resume hat recheck must re-resolve the
  // CONVERSATION's bound hat, not the org default — so persist which
  // conversation gated the tool. Older DBs predate the column; add it
  // idempotently (SQLite throws "duplicate column name" if it already exists).
  try { db.exec('ALTER TABLE tool_approvals ADD COLUMN conversation_id TEXT'); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
  // QUOXON-ASK lane J: a caller-session tool's human approval, recorded while the row
  // stays pending until the caller's own turn runs it (see CALLER_SESSION_RESUME_TOOLS).
  for (const col of ['caller_approved_by TEXT', 'caller_approved_at INTEGER']) {
    try { db.exec(`ALTER TABLE tool_approvals ADD COLUMN ${col}`); }
    catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
  }
  _db = db;
}

function requireDb() {
  if (!_db) throw new Error('toolApprovalStore.ensure(db) must be called before use');
  return _db;
}

/**
 * Insert (or refresh) a pending row for a gated tool call awaiting approval.
 */
function putPending({ approval_id, org_id, agent_id, user_id, tool_name, input_json, resume_token, conversation_id }) {
  if (!approval_id) throw new Error('putPending requires approval_id');
  if (!resume_token) throw new Error('putPending requires resume_token');
  const db = requireDb();
  const t = Date.now();
  db.prepare(`
    INSERT INTO tool_approvals
      (approval_id, org_id, agent_id, user_id, tool_name, input_json, resume_token, conversation_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(approval_id) DO UPDATE SET
      org_id          = excluded.org_id,
      agent_id        = excluded.agent_id,
      user_id         = excluded.user_id,
      tool_name       = excluded.tool_name,
      input_json      = excluded.input_json,
      resume_token    = excluded.resume_token,
      conversation_id = excluded.conversation_id,
      status          = 'pending',
      updated_at      = excluded.updated_at
  `).run(
    approval_id,
    org_id || null,
    agent_id || null,
    user_id || null,
    tool_name || null,
    input_json || null,
    resume_token,
    conversation_id || null,
    t,
    t
  );
  const row = getByApprovalId(approval_id);
  require('./lucid/emit.js').approvalEvent(row, 'pending');
  return row;
}

/**
 * APPROVAL-SPAM 2/6: an identical PENDING proposal (same org, tool, stripped
 * input and conversation) created within `withinMs`, or null. Scoped to a
 * conversation on purpose: with no conversation id nothing is ever merged, so
 * unrelated callers can never end up sharing one approval.
 */
function findPendingDuplicate({ org_id, tool_name, input_json, conversation_id, withinMs = 60 * 60 * 1000 }) {
  if (!_db || !org_id || !tool_name || !conversation_id) return null;
  return _db.prepare(`
    SELECT * FROM tool_approvals
    WHERE status = 'pending' AND org_id = ? AND tool_name = ? AND conversation_id = ?
      AND input_json IS ? AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1
  `).get(org_id, tool_name, conversation_id, input_json ?? null, Date.now() - withinMs) || null;
}

/** APPROVAL-SPAM 3/6: stale pending rows for the given tools, oldest first. */
function listExpirable({ tools, olderThan, limit = 200 }) {
  if (!_db || !tools || tools.length === 0) return [];
  const ph = tools.map(() => '?').join(',');
  return _db.prepare(`
    SELECT approval_id, org_id, tool_name, created_at FROM tool_approvals
    WHERE status = 'pending' AND tool_name IN (${ph}) AND created_at < ?
    ORDER BY created_at ASC LIMIT ?
  `).all(...tools, olderThan, limit);
}

/** Every stale pending row regardless of tool, oldest first (one approval lifetime for all). */
function listStalePending({ olderThan, limit = 200 }) {
  if (!_db) return [];
  return _db.prepare(`
    SELECT approval_id, org_id, tool_name, created_at FROM tool_approvals
    WHERE status = 'pending' AND created_at < ?
    ORDER BY created_at ASC LIMIT ?
  `).all(olderThan, limit);
}

/**
 * journey-server-trouble (SITE-CLI 2026-10-17): how many approval rows this org+user raised since a time, any status.
 * null when the store is not open (unknown is never read as "none were filed").
 */
function countCreatedSince({ org_id, user_id, since }) {
  if (!_db || !org_id || !user_id || !Number.isFinite(Number(since))) return null;
  try {
    const row = _db.prepare('SELECT COUNT(*) AS n FROM tool_approvals WHERE org_id = ? AND user_id = ? AND created_at >= ?').get(org_id, user_id, Number(since));
    return row ? Number(row.n) : null;
  } catch { return null; }
}

/** Rows whose expiry landed but whose card close failed; retried each tick. */
function listCloseRetries({ limit = 200 } = {}) {
  if (!_db) return [];
  return _db.prepare(`
    SELECT approval_id, org_id, tool_name FROM tool_approvals
    WHERE status = 'expire_close_failed' ORDER BY updated_at ASC LIMIT ?
  `).all(limit);
}

/** Mark the card-close outcome for an expired row (never back to pending). */
function setExpiryCloseState(approval_id, closed) {
  requireDb().prepare(`
    UPDATE tool_approvals SET status = ?, updated_at = ?
    WHERE approval_id = ? AND status IN ('expired', 'expire_close_failed')
  `).run(closed ? 'expired' : 'expire_close_failed', Date.now(), approval_id);
}

/** Compare-and-swap pending -> expired. Returns true only if THIS call expired it. */
function expirePending(approval_id) {
  const info = requireDb().prepare(`
    UPDATE tool_approvals SET status = 'expired', updated_at = ?
    WHERE approval_id = ? AND status = 'pending'
  `).run(Date.now(), approval_id);
  if (info.changes === 1) require('./lucid/emit.js').approvalEvent(getByApprovalId(approval_id), 'expired');
  return info.changes === 1;
}

/**
 * QUOXON-ASK lane J: tools whose approved execution must run in the requesting user's
 * own session (their bearer). The async resume records the human approval here and
 * leaves the row pending; withApprovalGate's poll branch honours it on the caller's
 * next turn, then claims the row single-use as for any approval.
 */
const CALLER_SESSION_RESUME_TOOLS = new Set(['quox_cli_write']);

/** Record a human approval on a still-pending caller-session row. -> true when recorded. */
function markCallerApproved(approval_id, approver) {
  const db = requireDb();
  const info = db.prepare(`
    UPDATE tool_approvals
    SET caller_approved_by = ?, caller_approved_at = ?, updated_at = ?
    WHERE approval_id = ? AND status = 'pending'
  `).run(approver ? String(approver) : 'approver', Date.now(), Date.now(), approval_id);
  return info.changes === 1;
}

function getByApprovalId(approval_id) {
  if (!_db) return null;
  return _db.prepare('SELECT * FROM tool_approvals WHERE approval_id = ?').get(approval_id) || null;
}

/**
 * Verify a caller-supplied resume_token against the stored row for
 * approval_id. Returns the row ONLY when the token matches EXACTLY (never on
 * presence alone) AND the row's status is still executable (see
 * VERIFIABLE_STATUSES). Returns null on any mismatch, unknown id, or
 * terminal-denied/error row.
 */
function verifyToken(approval_id, resume_token) {
  if (!approval_id || !resume_token || !_db) return null;
  const row = getByApprovalId(approval_id);
  if (!row) return null;
  if (row.resume_token !== resume_token) return null;
  if (!VERIFIABLE_STATUSES.has(row.status)) return null;
  return row;
}

/**
 * The idempotency lock. Conditionally flip pending → resuming. Returns the
 * (now-resuming) row on the FIRST claim, or null on any later claim (row
 * already resuming/terminal, or unknown approval_id). The resume executor
 * MUST call this first and no-op when it returns null.
 */
function claimForResume(approval_id) {
  const db = requireDb();
  const info = db.prepare(`
    UPDATE tool_approvals
    SET status = 'resuming', updated_at = ?
    WHERE approval_id = ? AND status = 'pending'
  `).run(Date.now(), approval_id);
  if (info.changes === 0) return null;
  const row = getByApprovalId(approval_id);
  require('./lucid/emit.js').approvalEvent(row, 'resuming');
  return row;
}

/**
 * Fleet standing grants (2026-10-13): a call a standing grant covers runs
 * without a human click, but it still lands here so approvals history shows
 * every use. Inserted straight into `resuming` (NEVER `pending`: a pending row
 * raises an owner ask in LUCID), then finalize() records the outcome. The
 * resume token is random and never returned, so the row cannot be resumed.
 */
function recordStandingGrantUse({ approval_id, org_id, agent_id, user_id, tool_name, input_json, conversation_id }) {
  if (!approval_id) throw new Error('recordStandingGrantUse requires approval_id');
  const db = requireDb();
  const t = Date.now();
  db.prepare(`
    INSERT INTO tool_approvals
      (approval_id, org_id, agent_id, user_id, tool_name, input_json, resume_token, conversation_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'resuming', ?, ?)
  `).run(
    approval_id, org_id || null, agent_id || null, user_id || null, tool_name, input_json || null,
    require('crypto').randomBytes(32).toString('hex'), conversation_id || null, t, t
  );
  return getByApprovalId(approval_id);
}

/**
 * Record a terminal outcome for a gated tool call.
 */
function finalize(approval_id, status, result_json = null) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`finalize: invalid status '${status}'`);
  }
  const db = requireDb();
  const info = db.prepare(`
    UPDATE tool_approvals
    SET status = ?, result_json = ?, updated_at = ?
    WHERE approval_id = ?
  `).run(status, result_json, Date.now(), approval_id);
  if (info.changes) {
    const row = getByApprovalId(approval_id);
    require('./lucid/emit.js').approvalEvent(row, status);
    for (const fn of finalizeListeners) {
      try {
        const r = fn(row, status, result_json);
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch (_) { /* a listener must never break finalize */ }
    }
  }
  return info.changes;
}

const finalizeListeners = [];
/** Register a listener called as fn(row, status, result_json) after a terminal outcome is stored. */
function onFinalized(fn) {
  if (typeof fn === 'function' && !finalizeListeners.includes(fn)) finalizeListeners.push(fn);
}

/**
 * LI-OVERHAUL P11 — org-scoped read of recent gated-tool history, the data
 * behind the LinkedIn Activity tab (and any future per-plugin activity
 * surface). Read-only; never returns resume_token.
 */
function listRecentByOrg(org_id, { toolPrefix = '', limit = 50 } = {}) {
  const db = requireDb();
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  return db.prepare(`
    SELECT approval_id, agent_id, user_id, tool_name, input_json, status,
           result_json, created_at, updated_at
    FROM tool_approvals
    WHERE org_id = ? AND tool_name LIKE ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(org_id, `${toolPrefix}%`, cappedLimit);
}

module.exports = {
  CALLER_SESSION_RESUME_TOOLS,
  countCreatedSince,
  markCallerApproved,
  listCloseRetries,
  setExpiryCloseState,
  listExpirable,
  listStalePending,
  expirePending,
  findPendingDuplicate,
  ensure,
  putPending,
  recordStandingGrantUse,
  getByApprovalId,
  verifyToken,
  claimForResume,
  finalize,
  onFinalized,
  listRecentByOrg,
  VALID_STATUSES,
};
