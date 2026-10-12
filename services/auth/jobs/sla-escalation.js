/**
 * LAUNCH-SPINE — HITL SLA escalation runner.
 *
 * STATUS_AND_LIMITS_HITL.md carried "Decision queue / SLA timers" as a Stub:
 * "`due_at` field exists on inbox items (sortable in UI). No server-side timer,
 * no escalation cron, no SLA breach notification." Accurate about the runner,
 * but understated what was already there: `escalation_stages` is a real table,
 * rows ARE written with `scheduled_at` when an item is filed with `sla_stages`
 * (routes/inbox.js), and the read routes already surface them. The only missing
 * piece was the thing that fires a stage when its time arrives — so a
 * configured SLA sat in the database and never did anything.
 *
 * House rule: browser timers are not background jobs. This lives in the auth
 * service, which owns the inbox tables, and follows the setTimeout-chain +
 * .unref() pattern from jobs/audit-event-reaper.js.
 *
 * Fail-safe direction: `auto_approve` is NOT executed unless explicitly opted
 * in via HITL_SLA_ALLOW_AUTO_APPROVE=true. A timer that approves on a human's
 * behalf with no human in the loop is exactly the failure mode a
 * human-in-the-loop surface exists to prevent, and it is the EU AI Act
 * Article 14 hook. Blocked stages are reported and left untriggered rather than
 * silently skipped, so they fire the moment the opt-in is granted.
 */

import { ulid } from '../utils/helpers.js';
import { getInstanceSetting } from '../lib/configResolver.js';

const POLL_INTERVAL_MS_DEFAULT = parseInt(process.env.HITL_SLA_POLL_INTERVAL_MS || '60000', 10); // 1 minute
const ALLOW_AUTO_APPROVE = process.env.HITL_SLA_ALLOW_AUTO_APPROVE === 'true';

// VAULT-INTEG P17: HITL_SLA_POLL_INTERVAL_MS was a bare process.env read
// frozen at module load. startSlaEscalation()'s scheduleNext() below
// re-arms its own setTimeout after every single tick (not once at boot,
// unlike a setInterval-based scheduler) — resolving this fresh on every
// scheduleNext() call means a stored/env override takes effect on the very
// next tick, genuinely live, no restart needed. Fail-safe: any resolver
// failure (no service key, network error, no override stored) falls back
// to the env value.
export async function resolvePollIntervalMs(deps = {}) {
  try {
    const resolved = await getInstanceSetting('HITL_SLA_POLL_INTERVAL_MS', deps);
    if (resolved && resolved.value !== undefined) {
      const n = Number(resolved.value);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch (err) {
    console.error('[HITL-SLA] HITL_SLA_POLL_INTERVAL_MS instance-setting resolver failed, falling back to env — %s', err.message);
  }
  return POLL_INTERVAL_MS_DEFAULT;
}

/** Statuses where a human decision is still outstanding. */
const ACTIONABLE_STATUSES = ['open', 'in_progress', 'waiting'];

let _timer = null;
let _running = false; // guards the start/stop race across scheduleNext()'s await (VAULT-INTEG P17)

/**
 * Find and fire every escalation stage that has come due.
 *
 * @param {object} db - SQLite database handle
 * @param {object} [opts]
 * @param {Function} [opts.notifier] - (orgId, item) => void, for the `notify` action
 * @param {boolean} [opts.allowAutoApprove] - override the env opt-in (tests)
 * @returns {{examined:number, fired:number, skipped:number, blocked:number, errors:number, blockedReasons:string[]}}
 */
export function processDueStages(db, opts = {}) {
    const allowAutoApprove = opts.allowAutoApprove ?? ALLOW_AUTO_APPROVE;
    const summary = { examined: 0, fired: 0, skipped: 0, blocked: 0, errors: 0, blockedReasons: [] };

    // Join to the item so a single query answers "is this still worth firing?".
    // Ordered by stage_num so a multi-stage ladder fires in the order it was
    // configured when several stages come due in the same tick.
    let due;
    try {
        due = db.prepare(`
            SELECT es.*, ii.org_id, ii.status AS item_status, ii.deleted_at, ii.title
            FROM escalation_stages es
            JOIN inbox_items ii ON ii.id = es.inbox_item_id
            WHERE es.triggered_at IS NULL
              AND es.scheduled_at IS NOT NULL
              AND es.scheduled_at <= datetime('now')
            ORDER BY es.inbox_item_id, es.stage_num
        `).all();
    } catch (err) {
        console.error('[HITL-SLA] Due-stage query failed: %s', err.message);
        summary.errors++;
        return summary;
    }

    for (const stage of due) {
        summary.examined++;

        // A resolved/cancelled/expired or deleted item needs no escalation.
        // Retire the stage so it stops being examined on every tick.
        if (stage.deleted_at || !ACTIONABLE_STATUSES.includes(stage.item_status)) {
            summary.skipped++;
            try { _stampTriggered(db, stage.id); } catch { /* best-effort retire */ }
            continue;
        }

        if (stage.action === 'auto_approve' && !allowAutoApprove) {
            // Loud, and deliberately NOT stamped: the operator configured this
            // and is entitled to know it did not happen.
            summary.blocked++;
            if (!summary.blockedReasons.includes('auto_approve')) summary.blockedReasons.push('auto_approve');
            console.warn(
                '[HITL-SLA] BLOCKED auto_approve on item %s (stage %d): set HITL_SLA_ALLOW_AUTO_APPROVE=true to permit ' +
                'timer-driven approval. Left pending rather than approved — a human decision is still outstanding.',
                stage.inbox_item_id, stage.stage_num
            );
            continue;
        }

        try {
            _applyAction(db, stage, opts);
            _stampTriggered(db, stage.id);
            _audit(db, stage);
            summary.fired++;
        } catch (err) {
            summary.errors++;
            console.error('[HITL-SLA] Stage %s (%s) on item %s failed: %s',
                stage.id, stage.action, stage.inbox_item_id, err.message);
        }
    }

    return summary;
}

function _stampTriggered(db, stageId) {
    db.prepare(`UPDATE escalation_stages SET triggered_at = datetime('now') WHERE id = ?`).run(stageId);
}

function _parseTarget(raw) {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

/** Shape mirrors the internal resolve route so auto-resolutions read identically. */
function _resolution(action) {
    return JSON.stringify({
        action,
        comment: 'SLA stage fired with no human response',
        responded_by: 'system:sla-escalation',
        responded_at: new Date().toISOString(),
    });
}

function _applyAction(db, stage, opts) {
    const itemId = stage.inbox_item_id;
    const target = _parseTarget(stage.target_json);

    switch (stage.action) {
        case 'notify': {
            // Best-effort: a dead channel must not make the stage re-fire every
            // tick forever, so a throwing notifier is logged and swallowed.
            if (typeof opts.notifier === 'function') {
                try {
                    opts.notifier(stage.org_id, { id: itemId, title: stage.title, org_id: stage.org_id });
                } catch (err) {
                    console.warn('[HITL-SLA] notify failed for item %s (non-fatal): %s', itemId, err.message);
                }
            }
            break;
        }

        case 'escalate': {
            db.prepare(`UPDATE inbox_items SET priority = 'urgent', updated_at = datetime('now') WHERE id = ?`).run(itemId);
            break;
        }

        case 'reassign': {
            const userIds = Array.isArray(target.user_ids) ? target.user_ids.filter(u => typeof u === 'string' && u) : [];
            if (userIds.length === 0) {
                throw new Error('reassign stage has no target user_ids');
            }
            db.prepare(`DELETE FROM inbox_item_assignees WHERE inbox_item_id = ?`).run(itemId);
            const insert = db.prepare(`
                INSERT INTO inbox_item_assignees (id, inbox_item_id, assignee_type, assignee_id, mode)
                VALUES (?, ?, 'user', ?, 'any')
            `);
            for (const userId of userIds) insert.run(ulid(), itemId, userId);
            db.prepare(`UPDATE inbox_items SET updated_at = datetime('now') WHERE id = ?`).run(itemId);
            break;
        }

        case 'auto_expire': {
            db.prepare(`
                UPDATE inbox_items SET status = 'expired', updated_at = datetime('now') WHERE id = ?
            `).run(itemId);
            break;
        }

        case 'auto_deny':
        case 'auto_approve': {
            const verdict = stage.action === 'auto_deny' ? 'denied' : 'approved';
            // resolved_by stays NULL: no human resolved this. The response body
            // names the runner so the trail never implies a person decided.
            db.prepare(`
                UPDATE inbox_items
                SET status = 'resolved', response_json = ?, resolved_by = NULL,
                    resolved_at = datetime('now'), updated_at = datetime('now')
                WHERE id = ?
            `).run(_resolution(verdict), itemId);
            break;
        }

        default:
            throw new Error(`unknown escalation action '${stage.action}'`);
    }
}

function _audit(db, stage) {
    try {
        db.prepare(`
            INSERT INTO audit_events (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json, created_at)
            VALUES (?, ?, 'system', 'sla-escalation', 'hitl.sla_stage_fired', 'inbox_item', ?, 'success', ?, datetime('now'))
        `).run(
            ulid(),
            stage.org_id,
            stage.inbox_item_id,
            JSON.stringify({
                stage_id: stage.id,
                stage_num: stage.stage_num,
                stage_action: stage.action,
                trigger_after_minutes: stage.trigger_after_minutes,
                scheduled_at: stage.scheduled_at,
            })
        );
    } catch (err) {
        // Audit failure must not undo the action that already happened.
        console.warn('[HITL-SLA] audit write failed for stage %s (non-fatal): %s', stage.id, err.message);
    }
}

/** One tick against the live database. */
function runTick() {
    try {
        const { getDb } = _deps();
        const db = getDb();
        if (!db) return;
        const summary = processDueStages(db, { notifier: _deps().notifier });
        if (summary.fired || summary.blocked || summary.errors) {
            console.log('[HITL-SLA] tick: examined=%d fired=%d skipped=%d blocked=%d errors=%d',
                summary.examined, summary.fired, summary.skipped, summary.blocked, summary.errors);
        }
    } catch (err) {
        console.error('[HITL-SLA] tick failed: %s', err.message);
    }
}

// Lazily resolved so importing this module in a test never drags in the real
// database or the notification router.
let _resolvedDeps = null;
function _deps() {
    if (!_resolvedDeps) _resolvedDeps = { getDb: () => null, notifier: undefined };
    return _resolvedDeps;
}

/**
 * Provide the live database handle and notifier. Called from server.js at boot.
 * @param {{getDb: Function, notifier?: Function}} deps
 */
export function configureSlaEscalation(deps) {
    _resolvedDeps = { getDb: deps.getDb, notifier: deps.notifier };
}

/** Start the SLA escalation runner. Idempotent. */
export function startSlaEscalation() {
    if (_running) {
        console.log('[HITL-SLA] Already running');
        return;
    }
    _running = true;

    // VAULT-INTEG P17: resolved fresh on every scheduleNext() call (i.e.
    // every tick), not once at boot — see resolvePollIntervalMs()'s comment.
    // Guards against the async gap: if stopSlaEscalation() runs while a
    // scheduleNext() call is still awaiting its resolver, `_running` is
    // false by the time the await returns and the timer must NOT be armed.
    const scheduleNext = async () => {
        const pollIntervalMs = await resolvePollIntervalMs();
        if (!_running) return;
        _timer = setTimeout(() => {
            runTick();
            scheduleNext();
        }, pollIntervalMs);
        if (_timer.unref) _timer.unref();
    };

    scheduleNext();
    console.log('[HITL-SLA] SLA escalation runner started (poll interval: %ds default, auto_approve %s)',
        POLL_INTERVAL_MS_DEFAULT / 1000, ALLOW_AUTO_APPROVE ? 'PERMITTED' : 'blocked');
}

/** Stop the runner. */
export function stopSlaEscalation() {
    _running = false;
    if (_timer) {
        clearTimeout(_timer);
        _timer = null;
        console.log('[HITL-SLA] SLA escalation runner stopped');
    }
}

/** Run one tick immediately (manual trigger / tests). */
export function runSlaEscalationNow() {
    runTick();
}

export default {
    processDueStages,
    configureSlaEscalation,
    startSlaEscalation,
    stopSlaEscalation,
    runSlaEscalationNow,
};
