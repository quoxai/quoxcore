/**
 * LIFECYCLE-P3-D4 — Audit Event Reaper
 *
 * Background job that processes the `pending_audit_events` table —
 * the durable retry queue for B1 `secret.access` events (and any other
 * audit events that failed to write on first attempt).
 *
 * Retry policy:
 *   - Poll every 60 seconds.
 *   - Pick up rows where next_attempt_at <= NOW AND attempts < 10.
 *   - On success: DELETE the row.
 *   - On failure: increment attempts, set next_attempt_at = NOW + backoff,
 *                 update failure_reason.
 *   - Backoff: 2^attempts * 30s, capped at 1 hour.
 *   - Dead letter: after 10 attempts, leave the row in place with attempts=10.
 *     Reaper logs a loud ERROR each iteration if dead-letter count > 0.
 *
 * Pattern follows powers-deprecation-ttl.js (setTimeout-chain + .unref()).
 */

import { getDb } from '../db/index.js';
import { ulid } from '../utils/helpers.js';

const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds
const MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 30 * 1000; // 30 seconds
const BACKOFF_CAP_MS = 60 * 60 * 1000; // 1 hour

let _timer = null;

/**
 * Compute the next attempt timestamp.
 * Backoff: min(2^attempts * 30s, 1hr).
 * @param {number} attempts - Current attempt count (before this attempt)
 */
function nextAttemptAt(attempts) {
  const backoffMs = Math.min(Math.pow(2, attempts) * BACKOFF_BASE_MS, BACKOFF_CAP_MS);
  return new Date(Date.now() + backoffMs).toISOString();
}

/**
 * Write a single pending audit event to audit_events.
 * Returns true on success, false on failure.
 * @param {object} db - SQLite database handle
 * @param {object} row - Row from pending_audit_events
 */
function _attemptWrite(db, row) {
  try {
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch (parseErr) {
      console.error('[LIFECYCLE-P3-D4] Dead-letter: cannot parse payload_json for row %s: %s',
        row.id, parseErr.message);
      return false;
    }

    const id = ulid();
    db.prepare(`
      INSERT INTO audit_events (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      payload.org_id || null,
      payload.actor_type || 'service',
      payload.actor_id || 'collector',
      payload.action || row.event_type,
      payload.target_type || null,
      payload.target_id || null,
      payload.status || 'success',
      JSON.stringify(payload.metadata || {}),
      payload.created_at || new Date().toISOString()
    );

    return true;
  } catch (err) {
    console.warn('[LIFECYCLE-P3-D4] Audit write failed for row %s: %s', row.id, err.message);
    return false;
  }
}

/**
 * Run one reaper iteration.
 * - Picks up all rows where next_attempt_at <= NOW AND attempts < MAX_ATTEMPTS.
 * - Attempts to write each to audit_events.
 * - On success: deletes the row.
 * - On failure: backs off and updates the row.
 * - Logs ERROR if any dead-letter rows (attempts >= MAX_ATTEMPTS) exist.
 */
function runReaper() {
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[LIFECYCLE-P3-D4] Cannot get DB handle: %s', err.message);
    return;
  }

  const now = new Date().toISOString();

  // Pick up pending rows
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, event_type, payload_json, attempts, failure_reason
      FROM pending_audit_events
      WHERE next_attempt_at <= ? AND attempts < ?
      ORDER BY next_attempt_at ASC
      LIMIT 100
    `).all(now, MAX_ATTEMPTS);
  } catch (err) {
    console.error('[LIFECYCLE-P3-D4] Failed to query pending_audit_events: %s', err.message);
    return;
  }

  if (rows.length > 0) {
    console.log('[LIFECYCLE-P3-D4] Processing %d pending audit event(s)', rows.length);
  }

  for (const row of rows) {
    const success = _attemptWrite(db, row);
    const attemptTs = new Date().toISOString();

    if (success) {
      try {
        db.prepare('DELETE FROM pending_audit_events WHERE id = ?').run(row.id);
        console.log('[LIFECYCLE-P3-D4] Processed pending audit event %s (attempts=%d)', row.id, row.attempts + 1);
      } catch (err) {
        console.warn('[LIFECYCLE-P3-D4] Failed to delete processed row %s: %s', row.id, err.message);
      }
    } else {
      const newAttempts = row.attempts + 1;
      const willDeadLetter = newAttempts >= MAX_ATTEMPTS;

      try {
        db.prepare(`
          UPDATE pending_audit_events
          SET attempts = ?, last_attempt_at = ?, next_attempt_at = ?, failure_reason = ?
          WHERE id = ?
        `).run(
          newAttempts,
          attemptTs,
          willDeadLetter ? attemptTs : nextAttemptAt(newAttempts),
          `Attempt ${newAttempts} failed`,
          row.id
        );

        if (willDeadLetter) {
          console.error('[LIFECYCLE-P3-D4] DEAD-LETTER: audit event %s exhausted %d attempts — manual intervention required',
            row.id, MAX_ATTEMPTS);
        }
      } catch (updateErr) {
        console.error('[LIFECYCLE-P3-D4] Failed to update retry state for row %s: %s', row.id, updateErr.message);
      }
    }
  }

  // Check for dead-letter count and log loudly if any exist
  try {
    const deadLetterCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM pending_audit_events WHERE attempts >= ?
    `).get(MAX_ATTEMPTS);

    if (deadLetterCount?.cnt > 0) {
      console.error('[LIFECYCLE-P3-D4] ERROR: %d dead-letter audit event(s) in pending_audit_events — manual review required',
        deadLetterCount.cnt);
    }
  } catch (err) {
    console.warn('[LIFECYCLE-P3-D4] Dead-letter count query failed: %s', err.message);
  }
}

/**
 * Start the audit event reaper job.
 * Idempotent — safe to call multiple times.
 */
export function startAuditEventReaper() {
  if (_timer) {
    console.log('[LIFECYCLE-P3-D4] Audit event reaper already running');
    return;
  }

  const scheduleNext = () => {
    _timer = setTimeout(() => {
      runReaper();
      scheduleNext();
    }, POLL_INTERVAL_MS);

    // Don't prevent process exit
    if (_timer.unref) _timer.unref();
  };

  // Run once immediately on startup to flush any events from a previous crash
  try {
    runReaper();
  } catch (err) {
    console.error('[LIFECYCLE-P3-D4] Initial reaper run failed: %s', err.message);
  }

  scheduleNext();
  console.log('[LIFECYCLE-P3-D4] Audit event reaper started (poll interval: %ds)', POLL_INTERVAL_MS / 1000);
}

/**
 * Stop the audit event reaper.
 */
export function stopAuditEventReaper() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
    console.log('[LIFECYCLE-P3-D4] Audit event reaper stopped');
  }
}

/**
 * Run the reaper immediately (for testing / manual trigger).
 */
export function runAuditEventReaperNow() {
  runReaper();
}

/**
 * Queue an audit event for retry.
 * Called when the primary audit write fails.
 *
 * @param {object} db - SQLite database handle
 * @param {string} eventType - e.g. 'secret.access'
 * @param {object} payload - Full payload needed to reconstruct the audit event
 */
export function queuePendingAuditEvent(db, eventType, payload) {
  try {
    const id = ulid();
    db.prepare(`
      INSERT INTO pending_audit_events (id, event_type, payload_json, attempts, next_attempt_at, created_at)
      VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))
    `).run(id, eventType, JSON.stringify(payload));
    console.log('[LIFECYCLE-P3-D4] Queued pending audit event id=%s type=%s', id, eventType);
    return id;
  } catch (err) {
    console.error('[LIFECYCLE-P3-D4] Failed to queue pending audit event type=%s: %s', eventType, err.message);
    return null;
  }
}

export { MAX_ATTEMPTS, BACKOFF_BASE_MS, BACKOFF_CAP_MS };
