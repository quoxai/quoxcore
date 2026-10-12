/**
 * X-PLUGIN phase 12 — pre-authorised scheduled PUBLISHING.
 *
 * Owner decision 2026-09-12, verbatim: "approve then schedule! trigger time is
 * not delayed". The approver's tap at compose time IS the approval. The chosen
 * time delays only the publish. There is no second tap and no fresh card at
 * fire time.
 *
 * This is a real change to the governance posture and it is deliberately
 * narrow. Read the scope guard before extending anything here:
 *
 *   SCOPE GUARD. This pre-authorised lane is reachable ONLY from dashboard
 *   compose, by a human with approver role, through POST /x/schedule (which
 *   uses requireHumanAdmin: a service key and an agent-operated session are
 *   both refused). Agent-initiated x_post/x_thread keep full HITL exactly as
 *   before and cannot reach this file. An agent must never be able to
 *   pre-authorise its own future publish.
 *
 * WHAT IS AND IS NOT REUSED
 *
 * The publish itself goes through xTools.executeXDecision, the same function
 * the decide endpoint drives, so credential binding, image upload, 429
 * handling, the ledger write and the AEE evidence are literally the same code.
 * The ONE thing this path does differently is WHEN the budget is claimed: the
 * claim is taken at approval time (here), not at fire time, because the human
 * committed to the post then and the slot must be reserved from that moment.
 * executeXDecision is therefore called with claimHeld:true so it does not try
 * to claim a second time and mistake our own row for a replay.
 *
 * RESTART SAFETY (the hazard CLAUDE.md's Loop & Restart Hygiene section is
 * about, and the reason this file has no setTimeout-on-boot work)
 *
 *   - Due-ness is computed from the DURABLE scheduled_publish_at column, never
 *     from process uptime, so a restart creates no new work and re-fires
 *     nothing. A row that was not due before a restart is still not due after.
 *   - Claiming a row for firing is an atomic UPDATE ... WHERE status='pending',
 *     so two ticks (or two processes) can never both fire the same row.
 *   - A row found in 'firing' at boot crashed MID-PUBLISH. It is NOT retried
 *     automatically, because the post may well have gone out and a blind retry
 *     would double-post. It is retired to 'needs_review' and a human is told.
 *     Refusing to guess is the only safe answer here.
 *
 * LOOP TRIAD (house rule, no exceptions)
 *   - failure accounting is DISTINCT from empty ticks: a tick with nothing due
 *     reports fired:0 and is not a failure, and never counts toward backoff.
 *   - capped backoff per row via attempts + next_attempt_at (durable, so it
 *     survives a restart rather than resetting to zero).
 *   - durable retirement: every row ends in published, failed, cancelled or
 *     needs_review, and none of those are ever selected again. Nothing is
 *     retried forever.
 */

'use strict';

const MAX_ATTEMPTS = 4;
/** Capped exponential backoff between fire attempts, in minutes. The last
 * value repeats until MAX_ATTEMPTS retires the row. */
const BACKOFF_MINUTES = [2, 10, 30];

/** Statuses that are finished. Never selected for firing again. */
const TERMINAL_STATUSES = new Set(['published', 'failed', 'cancelled', 'needs_review']);

function initXScheduledPublishStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_scheduled_publishes (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      inbox_item_id        TEXT NOT NULL UNIQUE,
      org_id               TEXT NOT NULL,
      action               TEXT NOT NULL,
      action_params        TEXT NOT NULL,
      approver             TEXT,
      approved_at          TEXT NOT NULL,
      scheduled_publish_at TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'pending',
      attempts             INTEGER NOT NULL DEFAULT 0,
      next_attempt_at      TEXT,
      fired_at             TEXT,
      published_at         TEXT,
      cancelled_at         TEXT,
      cancelled_by         TEXT,
      last_error           TEXT,
      tweet_ids            TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_x_sched_due
      ON x_scheduled_publishes(status, scheduled_publish_at);
    CREATE INDEX IF NOT EXISTS idx_x_sched_org
      ON x_scheduled_publishes(org_id, scheduled_publish_at);
  `);
}

function parseRow(row) {
  if (!row) return null;
  let params = {};
  let tweetIds = [];
  try { params = JSON.parse(row.action_params || '{}'); } catch { params = {}; }
  try {
    const parsed = JSON.parse(row.tweet_ids || '[]');
    if (Array.isArray(parsed)) tweetIds = parsed;
  } catch { tweetIds = []; }
  return { ...row, action_params: params, tweet_ids: tweetIds };
}

/**
 * Record an approved-and-scheduled publish.
 *
 * The caller MUST already have taken the budget claim (see the module header:
 * the claim belongs to approval time). This function only records the
 * intention to publish later.
 *
 * action_params is stored verbatim EXCEPT that it must never contain anything
 * credential-shaped; the same secret-hygiene rule the approval card obeys
 * applies here, because this row is round-tripped through a scheduler and read
 * back by a route. Only credential_id (an opaque reference) is permitted, and
 * it is re-resolved at fire time.
 */
function scheduleApprovedPublish(db, { orgId, inboxItemId, action, actionParams, approver, scheduledPublishAt, now = new Date() }) {
  if (!orgId) throw new Error('orgId is required to schedule a publish');
  if (!inboxItemId) throw new Error('inboxItemId is required to schedule a publish');
  if (!action) throw new Error('action is required to schedule a publish');
  if (!scheduledPublishAt) throw new Error('scheduledPublishAt is required');

  const whenMs = Date.parse(scheduledPublishAt);
  if (!Number.isFinite(whenMs)) {
    return { ok: false, error: 'scheduled_publish_at is not a valid date' };
  }
  if (whenMs <= now.getTime()) {
    return { ok: false, error: 'scheduled_publish_at must be in the future' };
  }

  const forbidden = ['api_key', 'api_secret', 'access_token', 'access_secret', 'token', 'secret', 'password'];
  for (const key of Object.keys(actionParams || {})) {
    if (forbidden.includes(key.toLowerCase())) {
      return { ok: false, error: `refusing to store credential-shaped field "${key}" on a scheduled publish` };
    }
  }

  try {
    db.prepare(`
      INSERT INTO x_scheduled_publishes
        (inbox_item_id, org_id, action, action_params, approver, approved_at, scheduled_publish_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      inboxItemId, orgId, action, JSON.stringify(actionParams || {}),
      approver || null, now.toISOString(), new Date(whenMs).toISOString()
    );
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      return { ok: false, error: 'this approval is already scheduled' };
    }
    throw e;
  }

  return { ok: true, scheduled: getByInboxItem(db, orgId, inboxItemId) };
}

function getByInboxItem(db, orgId, inboxItemId) {
  // Always org-predicated: an inbox item id must never reach across tenants.
  return parseRow(db.prepare(
    'SELECT * FROM x_scheduled_publishes WHERE inbox_item_id = ? AND org_id = ?'
  ).get(inboxItemId, orgId));
}

/** Everything scheduled for one org, newest intent first. */
function listForOrg(db, orgId, { limit = 50, pendingOnly = false } = {}) {
  const sql = pendingOnly
    ? `SELECT * FROM x_scheduled_publishes WHERE org_id = ? AND status = 'pending' ORDER BY scheduled_publish_at ASC LIMIT ?`
    : `SELECT * FROM x_scheduled_publishes WHERE org_id = ? ORDER BY scheduled_publish_at DESC LIMIT ?`;
  return db.prepare(sql).all(orgId, limit).map(parseRow);
}

/**
 * Cancel a pending scheduled publish. Only a pending row can be cancelled: one
 * already firing may have reached X, and one already published certainly has,
 * so neither may be "cancelled" into a state that implies nothing happened.
 *
 * Releasing the budget claim is the caller's job (it owns the claims table);
 * this returns the row so the caller knows what to release.
 */
function cancelScheduledPublish(db, { orgId, inboxItemId, cancelledBy, now = new Date() }) {
  const existing = getByInboxItem(db, orgId, inboxItemId);
  if (!existing) return { ok: false, error: 'no scheduled publish found for this item' };
  if (existing.status !== 'pending') {
    return { ok: false, error: `cannot cancel a scheduled publish that is already ${existing.status}`, scheduled: existing };
  }

  const res = db.prepare(`
    UPDATE x_scheduled_publishes
    SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?
    WHERE inbox_item_id = ? AND org_id = ? AND status = 'pending'
  `).run(now.toISOString(), cancelledBy || null, inboxItemId, orgId);

  if (res.changes === 0) {
    // Lost a race with the scheduler; it is firing right now.
    return { ok: false, error: 'this publish started firing before the cancellation arrived', scheduled: getByInboxItem(db, orgId, inboxItemId) };
  }
  return { ok: true, scheduled: getByInboxItem(db, orgId, inboxItemId) };
}

/** Rows whose time has come and which are not backing off. */
function listDue(db, now = new Date()) {
  const nowIso = now.toISOString();
  return db.prepare(`
    SELECT * FROM x_scheduled_publishes
    WHERE status = 'pending'
      AND scheduled_publish_at <= ?
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY scheduled_publish_at ASC
  `).all(nowIso, nowIso).map(parseRow);
}

/**
 * Atomically take a due row for firing. Returns false if another tick (or
 * another process) got there first, which is what makes double-firing
 * impossible without a lock.
 */
function claimForFiring(db, { inboxItemId, orgId, now = new Date() }) {
  const res = db.prepare(`
    UPDATE x_scheduled_publishes
    SET status = 'firing', attempts = attempts + 1, fired_at = ?
    WHERE inbox_item_id = ? AND org_id = ? AND status = 'pending'
  `).run(now.toISOString(), inboxItemId, orgId);
  return res.changes === 1;
}

function markPublished(db, { orgId, inboxItemId, tweetIds = [], now = new Date() }) {
  db.prepare(`
    UPDATE x_scheduled_publishes
    SET status = 'published', published_at = ?, tweet_ids = ?, last_error = NULL
    WHERE inbox_item_id = ? AND org_id = ?
  `).run(now.toISOString(), JSON.stringify(tweetIds || []), inboxItemId, orgId);
}

/**
 * Record a failed attempt. Either schedules a capped-backoff retry or retires
 * the row permanently. Retirement is what stops a broken publish being
 * re-attempted forever.
 *
 * @returns {{ retired: boolean, attempts: number, nextAttemptAt: string|null }}
 */
function markAttemptFailed(db, { orgId, inboxItemId, error, now = new Date() }) {
  const row = getByInboxItem(db, orgId, inboxItemId);
  const attempts = row ? row.attempts : MAX_ATTEMPTS;

  if (attempts >= MAX_ATTEMPTS) {
    db.prepare(`
      UPDATE x_scheduled_publishes
      SET status = 'failed', last_error = ?, next_attempt_at = NULL
      WHERE inbox_item_id = ? AND org_id = ?
    `).run(String(error || 'unknown error'), inboxItemId, orgId);
    return { retired: true, attempts, nextAttemptAt: null };
  }

  const backoffMin = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1];
  const nextAttemptAt = new Date(now.getTime() + backoffMin * 60 * 1000).toISOString();
  db.prepare(`
    UPDATE x_scheduled_publishes
    SET status = 'pending', last_error = ?, next_attempt_at = ?
    WHERE inbox_item_id = ? AND org_id = ?
  `).run(String(error || 'unknown error'), nextAttemptAt, inboxItemId, orgId);
  return { retired: false, attempts, nextAttemptAt };
}

/**
 * Retire rows left in 'firing' by a crash or a container restart.
 *
 * These are the genuinely ambiguous ones: the process died between calling X
 * and recording the outcome, so the post may or may not exist. A blind retry
 * could double-post to a real account, so this refuses to guess and hands the
 * decision to a human. Called once at scheduler start, before any tick.
 *
 * @returns {Array} the rows that were retired, so the caller can tell someone
 */
function reclaimInterruptedFirings(db, { now = new Date() } = {}) {
  const stuck = db.prepare(`SELECT * FROM x_scheduled_publishes WHERE status = 'firing'`).all().map(parseRow);
  if (!stuck.length) return [];
  const stmt = db.prepare(`
    UPDATE x_scheduled_publishes
    SET status = 'needs_review', last_error = ?
    WHERE inbox_item_id = ? AND org_id = ? AND status = 'firing'
  `);
  const message = 'The collector stopped while this publish was in flight, so it is not known whether the post reached X. It has NOT been retried, because retrying could publish it twice. Check the account and resolve this by hand.';
  for (const row of stuck) stmt.run(message, row.inbox_item_id, row.org_id);
  return stuck.map((row) => ({ ...row, status: 'needs_review', last_error: message }));
}

module.exports = {
  MAX_ATTEMPTS,
  BACKOFF_MINUTES,
  TERMINAL_STATUSES,
  initXScheduledPublishStore,
  scheduleApprovedPublish,
  getByInboxItem,
  listForOrg,
  cancelScheduledPublish,
  listDue,
  claimForFiring,
  markPublished,
  markAttemptFailed,
  reclaimInterruptedFirings,
};
