/**
 * HITL-VOLT-WITNESS (QuoxPlan #2202) — reliable VOLT emission for approval
 * decisions.
 *
 * Auth owns the durable truth of an approval decision (inbox_items /
 * run_events — see routes/inbox.js). Auth does NOT own the VOLT DB —
 * collector does — so witnessing a decision in VOLT means an HTTP call to
 * collector's POST /api/internal/volt/emit (same mechanism LIFECYCLE-P3-D2
 * uses for power.deploy events, see routes/powers.js `_emitVoltDeployEvent`).
 *
 * That call can fail (VOLT outage, network blip, collector restart mid
 * request). `emitApprovalVoltWitness()` tries once immediately; on failure
 * it logs LOUDLY (never a silent catch) and queues the event in
 * `pending_volt_events` so a background reaper retries it. This mirrors
 * `jobs/audit-event-reaper.js`'s pending_audit_events pattern (poll +
 * exponential backoff + dead-letter after MAX_ATTEMPTS), reusing that
 * design rather than inventing a new one.
 *
 * Retry policy (identical constants to audit-event-reaper.js):
 *   - Poll every 60 seconds.
 *   - Pick up rows where next_attempt_at <= NOW AND attempts < 10.
 *   - On success: DELETE the row.
 *   - On failure: increment attempts, set next_attempt_at = NOW + backoff,
 *                 update failure_reason.
 *   - Backoff: 2^attempts * 30s, capped at 1 hour.
 *   - Dead letter: after 10 attempts, leave the row in place with attempts=10,
 *     and log a loud ERROR each iteration while dead-letter rows exist.
 */

import { getDb } from '../db/index.js';
import { ulid } from '../utils/helpers.js';

const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds
const MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 30 * 1000; // 30 seconds
const BACKOFF_CAP_MS = 60 * 60 * 1000; // 1 hour

const COLLECTOR_URL = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

/** Maps an inbox respond/cancel decision to the VOLT event_type (spec §8 + vendor cancelled). */
export const HITL_EVENT_TYPES = {
  granted: 'hitl.approved',
  denied: 'hitl.denied',
  cancelled: 'hitl.cancelled',
};

let _timer = null;

function nextAttemptAt(attempts) {
  const backoffMs = Math.min(Math.pow(2, attempts) * BACKOFF_BASE_MS, BACKOFF_CAP_MS);
  return new Date(Date.now() + backoffMs).toISOString();
}

/**
 * Real sender: POSTs a VOLT emit payload to the collector's internal
 * endpoint. Returns { ok, error }. Never throws — network/timeout/HTTP
 * failures are captured in the return value so callers can decide to queue.
 * @param {object} payload - { corr, event_type, context, payload }
 */
export async function sendVoltEmit(payload, { timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${COLLECTOR_URL}/api/internal/volt/emit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `collector responded ${resp.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Queue a VOLT witness event for retry. Called when the immediate send fails.
 * @param {object} db - SQLite database handle
 * @param {string} eventType
 * @param {object} payload - Full payload needed to retry the emit unchanged
 * @returns {string|null} row id, or null if the queue write itself failed
 */
export function queuePendingVoltEvent(db, eventType, payload) {
  try {
    const id = ulid();
    db.prepare(`
      INSERT INTO pending_volt_events (id, event_type, payload_json, attempts, next_attempt_at, created_at)
      VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))
    `).run(id, eventType, JSON.stringify(payload));
    console.log('[HITL/VOLT] Queued pending witness event id=%s type=%s', id, eventType);
    return id;
  } catch (err) {
    console.error('[HITL/VOLT] Failed to queue pending witness event type=%s: %s', eventType, err.message);
    return null;
  }
}

/**
 * Attempt the durable, retried emission of an approval decision witness.
 * Tries once immediately; on failure logs loudly (no silent catch) and
 * queues for the background reaper. Never throws.
 *
 * @param {object} decision - { orgId, itemId, decision: 'granted'|'denied'|'cancelled', actor, comment,
 *   actorType } - actorType defaults to 'human' (the two authenticated-route
 *   callers). The internal resolve passes 'agent_driven_test' for a sandbox
 *   synthetic resolution (P2): the witness must never record an agent-driven
 *   test approval as a human decision.
 * @param {object} [deps] - test seams: { db, sendFn }
 */
export async function emitApprovalVoltWitness({ orgId, itemId, decision, actor, comment, actorType } = {}, deps = {}) {
  const eventType = HITL_EVENT_TYPES[decision];
  if (!eventType || !itemId) return; // not a recognised decision — nothing to witness

  // NOTE on shape: collector's POST /api/internal/volt/emit spreads
  // req.body.payload straight into voltEmitter.emit(runId, eventType, payload),
  // which reads `payload.actor` for the event's top-level `actor` field (same
  // slot every other VOLT event uses for its actor) and then STRIPS `actor`/
  // `context` out of what becomes `eventObj.payload` (sanitizePayload). So the
  // approver identity MUST travel as `payload.actor` (a structured
  // { actor_type, actor_id }, spec-aligned with every other VOLT event) —
  // not as a plain string field, or it is silently dropped from the record.
  const payload = {
    corr: itemId,
    event_type: eventType,
    context: { org_id: orgId || null },
    payload: {
      item_id: itemId,
      action: decision,
      actor: { actor_type: actorType || 'human', actor_id: actor || 'unknown' },
      comment: comment ? String(comment).slice(0, 300) : undefined,
    },
  };

  const send = deps.sendFn || sendVoltEmit;
  const result = await send(payload);

  if (!result.ok) {
    console.error(
      '[HITL/VOLT] Witness emit FAILED for item=%s decision=%s (queued for retry, not lost): %s',
      itemId, decision, result.error
    );
    const db = deps.db || getDb();
    queuePendingVoltEvent(db, eventType, payload);
  }
}

/**
 * Run one reaper iteration: pick up ready rows, retry the send, delete on
 * success, back off (or dead-letter) on failure.
 * @param {object} db - SQLite database handle
 * @param {object} [opts] - { sendFn } test seam
 */
export async function runVoltWitnessReaperOnce(db, { sendFn } = {}) {
  const send = sendFn || sendVoltEmit;
  const now = new Date().toISOString();

  let rows;
  try {
    rows = db.prepare(`
      SELECT id, event_type, payload_json, attempts
      FROM pending_volt_events
      WHERE next_attempt_at <= ? AND attempts < ?
      ORDER BY next_attempt_at ASC
      LIMIT 100
    `).all(now, MAX_ATTEMPTS);
  } catch (err) {
    console.error('[HITL/VOLT] Failed to query pending_volt_events: %s', err.message);
    return;
  }

  if (rows.length > 0) {
    console.log('[HITL/VOLT] Reaper processing %d pending witness event(s)', rows.length);
  }

  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch (parseErr) {
      console.error('[HITL/VOLT] DEAD-LETTER: cannot parse payload_json for row %s: %s', row.id, parseErr.message);
      continue;
    }

    const result = await send(payload);
    const attemptTs = new Date().toISOString();

    if (result.ok) {
      try {
        db.prepare('DELETE FROM pending_volt_events WHERE id = ?').run(row.id);
        console.log('[HITL/VOLT] Delivered queued witness event %s (attempts=%d)', row.id, row.attempts + 1);
      } catch (err) {
        console.warn('[HITL/VOLT] Failed to delete delivered row %s: %s', row.id, err.message);
      }
    } else {
      const newAttempts = row.attempts + 1;
      const willDeadLetter = newAttempts >= MAX_ATTEMPTS;
      try {
        db.prepare(`
          UPDATE pending_volt_events
          SET attempts = ?, last_attempt_at = ?, next_attempt_at = ?, failure_reason = ?
          WHERE id = ?
        `).run(newAttempts, attemptTs, willDeadLetter ? attemptTs : nextAttemptAt(newAttempts), result.error, row.id);

        if (willDeadLetter) {
          console.error('[HITL/VOLT] DEAD-LETTER: witness event %s exhausted %d attempts — manual intervention required',
            row.id, MAX_ATTEMPTS);
        }
      } catch (updateErr) {
        console.error('[HITL/VOLT] Failed to update retry state for row %s: %s', row.id, updateErr.message);
      }
    }
  }

  try {
    const deadLetterCount = db.prepare(`SELECT COUNT(*) AS cnt FROM pending_volt_events WHERE attempts >= ?`).get(MAX_ATTEMPTS);
    if (deadLetterCount?.cnt > 0) {
      console.error('[HITL/VOLT] ERROR: %d dead-letter witness event(s) in pending_volt_events — manual review required', deadLetterCount.cnt);
    }
  } catch (err) {
    console.warn('[HITL/VOLT] Dead-letter count query failed: %s', err.message);
  }
}

/** Starts the background reaper. Idempotent — safe to call multiple times. */
export function startVoltWitnessReaper() {
  if (_timer) {
    console.log('[HITL/VOLT] Witness reaper already running');
    return;
  }

  const scheduleNext = () => {
    _timer = setTimeout(() => {
      runVoltWitnessReaperOnce(getDb()).finally(scheduleNext);
    }, POLL_INTERVAL_MS);
    if (_timer.unref) _timer.unref();
  };

  runVoltWitnessReaperOnce(getDb())
    .catch((err) => console.error('[HITL/VOLT] Initial reaper run failed: %s', err.message))
    .finally(() => {
      scheduleNext();
      console.log('[HITL/VOLT] Witness reaper started (poll interval: %ds)', POLL_INTERVAL_MS / 1000);
    });
}

/** Stops the background reaper. */
export function stopVoltWitnessReaper() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
    console.log('[HITL/VOLT] Witness reaper stopped');
  }
}

export { MAX_ATTEMPTS, BACKOFF_BASE_MS, BACKOFF_CAP_MS };
