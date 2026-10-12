/**
 * X-PLUGIN phase 12 — the scheduler that fires pre-authorised publishes.
 *
 * See lib/xScheduledPublish.js for the governance decision, the scope guard
 * and the restart-safety design. This file is only the loop.
 *
 * THE LOOP TRIAD, which CLAUDE.md makes non-negotiable after the 2026-08-30
 * incident:
 *
 *   FAILURE ACCOUNTING DISTINCT FROM EMPTY. A tick with nothing due returns
 *   { due: 0, fired: 0, failed: 0 } and is reported as idle. "0 failed" while
 *   the dependency is down is the exact lie that hid a 30 hour outage, so a
 *   publish that threw is counted in `failed` and logged with its reason,
 *   never folded into "nothing to do".
 *
 *   CAPPED BACKOFF. Per ROW, via attempts + next_attempt_at in the table, not
 *   in memory. A restart therefore resumes the backoff rather than resetting
 *   it to zero and hammering X.
 *
 *   DURABLE RETIREMENT. Every row ends published, failed, cancelled or
 *   needs_review, and none are selected again. Nothing is retried forever.
 *
 * NO STARTUP-TRIGGERED WORK. The tick does not fire anything because the
 * process started; it fires rows whose durable scheduled_publish_at has
 * passed. A restart loop cannot manufacture publishes. The one thing that DOES
 * happen at start is reclaimInterruptedFirings(), which only ever retires rows
 * and never publishes.
 */

'use strict';

const xScheduledPublish = require('./xScheduledPublish.js');
const { mintInboxItem } = require('./inboxMint.js');
const xPostingStore = require('./xPostingStore.js');

const DEFAULT_WARMUP_MS = 45 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000; // a minute's granularity on a chosen time is plenty

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

/**
 * Tell a human that a scheduled publish did not happen. Honest failure: the
 * item says plainly that NOTHING was posted, so silence is never mistaken for
 * success. Best effort by design, because failing to file the notice must not
 * also lose the retirement of the row.
 */
async function fileFailureNotice(orgId, { title, bodyMd }) {
  if (!INTERNAL_SERVICE_KEY) {
    console.error('[XPublishSched] INTERNAL_SERVICE_KEY not set, cannot file a failure notice');
    return { ok: false, error: 'INTERNAL_SERVICE_KEY not configured' };
  }
  // quox#562: mechanics live in lib/inboxMint.js (never throws).
  const r = await mintInboxItem({
    orgId, title, bodyMd, kind: 'info', priority: 'high',
    payload: { source: 'x-plugin', kind: 'scheduled_publish_failure' },
  }, { authBaseUrl: AUTH_SERVICE_URL, serviceKey: INTERNAL_SERVICE_KEY });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * Fire one due row.
 *
 * The publish goes through the injected executeDecision, which in production
 * is xTools.executeXDecision: the SAME function the decide endpoint drives.
 * claimHeld is true because the budget was claimed at approval time, so this
 * path must not claim again and mistake its own row for a replay.
 */
async function fireOne(db, row, deps = {}) {
  const now = deps.now instanceof Date ? deps.now : new Date();
  const executeDecision = deps.executeDecision || require('./xTools.js').executeXDecision;
  const fileNotice = deps.fileFailureNoticeFn || fileFailureNotice;

  if (!xScheduledPublish.claimForFiring(db, { inboxItemId: row.inbox_item_id, orgId: row.org_id, now })) {
    // Another tick took it, or it was cancelled between select and claim.
    return { fired: false, skipped: true, reason: 'not claimable' };
  }

  let result;
  try {
    result = await executeDecision(
      {
        action: row.action,
        actionParams: row.action_params,
        orgId: row.org_id,
        inboxItemId: row.inbox_item_id,
      },
      // claimHeld: the reservation was taken when the human approved.
      { claimHeld: true, approver: row.approver, scheduled: true }
    );
  } catch (err) {
    result = { success: false, error: `publish threw: ${err.message}` };
  }

  if (result && result.success) {
    const tweetIds = result.tweet_id ? [result.tweet_id] : (result.tweet_ids || result.posted_tweet_ids || []);
    xScheduledPublish.markPublished(db, { orgId: row.org_id, inboxItemId: row.inbox_item_id, tweetIds, now: new Date() });
    console.log(`[XPublishSched] org=${row.org_id} item=${row.inbox_item_id}: published on schedule (approved ${row.approved_at}, due ${row.scheduled_publish_at})`);
    return { fired: true, success: true, tweetIds };
  }

  const error = (result && result.error) || 'unknown publish failure';
  const outcome = xScheduledPublish.markAttemptFailed(db, {
    orgId: row.org_id, inboxItemId: row.inbox_item_id, error, now,
  });

  if (outcome.retired) {
    // The claim reserved budget for a post that will now never happen. Release
    // it, or this org silently loses a posting slot forever.
    try {
      xPostingStore.markClaimFailed(db, row.org_id, row.inbox_item_id, `scheduled publish failed: ${error}`);
    } catch (e) {
      console.error(`[XPublishSched] could not release the budget claim for ${row.inbox_item_id}: ${e.message}`);
    }
    await fileNotice(row.org_id, {
      title: 'X scheduled post FAILED, nothing was published',
      bodyMd: [
        '**A scheduled X post did not go out.**',
        '',
        `It was approved at \`${row.approved_at}\` and due at \`${row.scheduled_publish_at}\`.`,
        '',
        `After ${outcome.attempts} attempts it was given up on. **Nothing was posted to X.**`,
        '',
        `Last error: ${error}`,
        '',
        'The posting budget it had reserved has been released. Compose it again if you still want it published.',
      ].join('\n'),
    });
    console.error(`[XPublishSched] org=${row.org_id} item=${row.inbox_item_id}: RETIRED after ${outcome.attempts} attempts, nothing posted, budget released. ${error}`);
  } else {
    console.error(`[XPublishSched] org=${row.org_id} item=${row.inbox_item_id}: attempt ${outcome.attempts} failed, retrying after ${outcome.nextAttemptAt}. ${error}`);
  }

  return { fired: true, success: false, retired: outcome.retired, error };
}

/**
 * One tick. Never throws: a single bad row must not stop the others, and a
 * scheduler that dies on one failure is worse than one that reports it.
 *
 * @returns {{ due:number, fired:number, failed:number, retired:number, skipped:number }}
 */
async function runPublishTick(db, deps = {}) {
  const now = deps.now instanceof Date ? deps.now : new Date();
  const due = xScheduledPublish.listDue(db, now);

  const stats = { due: due.length, fired: 0, failed: 0, retired: 0, skipped: 0 };

  for (const row of due) {
    try {
      const out = await fireOne(db, row, deps);
      if (out.skipped) { stats.skipped++; continue; }
      if (out.success) stats.fired++;
      else {
        // A failure is counted as a failure, distinctly from an empty tick.
        stats.failed++;
        if (out.retired) stats.retired++;
      }
    } catch (err) {
      stats.failed++;
      console.error(`[XPublishSched] org=${row.org_id} item=${row.inbox_item_id}: tick-level failure, ${err.message}`);
    }
  }

  if (stats.due === 0) {
    // Idle, and said so as idle. Not a failure, and it must never be counted
    // as one, nor trigger backoff.
    console.log('[XPublishSched] tick: nothing due');
  } else {
    console.log(`[XPublishSched] tick: ${stats.due} due, ${stats.fired} published, ${stats.failed} failed (${stats.retired} retired), ${stats.skipped} skipped`);
  }
  return stats;
}

/**
 * Start the scheduler.
 *
 * @param {object} deps
 * @param {object} deps.db - REQUIRED
 * @param {number} [deps.warmupMs] / [deps.intervalMs] - test overrides
 * @param {boolean} [deps.runNow] - run one tick immediately instead of timing (tests)
 * @param {function} [deps.setTimeoutFn] / [deps.setIntervalFn] - test seams
 * @param {function} [deps.executeDecision] - override the publish (tests)
 */
async function startXPublishScheduler(deps = {}) {
  const db = deps.db;
  if (!db) {
    console.error('[XPublishSched] no db provided, not starting (durable schedule state requires it)');
    return;
  }
  xScheduledPublish.initXScheduledPublishStore(db);

  // Boot housekeeping, and the ONLY thing that happens because the process
  // started. It publishes nothing; it retires rows a crash left mid-flight and
  // tells a human, because a blind retry could double-post.
  const stuck = xScheduledPublish.reclaimInterruptedFirings(db);
  for (const row of stuck) {
    console.error(`[XPublishSched] org=${row.org_id} item=${row.inbox_item_id}: was in flight when the collector stopped. NOT retried, marked needs_review.`);
    (deps.fileFailureNoticeFn || fileFailureNotice)(row.org_id, {
      title: 'X scheduled post interrupted, please check the account',
      bodyMd: [
        '**A scheduled X post was in flight when the collector stopped.**',
        '',
        `Approved at \`${row.approved_at}\`, due at \`${row.scheduled_publish_at}\`.`,
        '',
        'It is NOT known whether the post reached X, so it has deliberately NOT been retried: retrying could publish it twice.',
        '',
        'Please check the account and resolve this one by hand.',
      ].join('\n'),
    }).catch(() => {});
  }

  const warmupMs = Number.isFinite(deps.warmupMs) ? deps.warmupMs : DEFAULT_WARMUP_MS;
  const intervalMs = Number.isFinite(deps.intervalMs) ? deps.intervalMs : DEFAULT_INTERVAL_MS;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const setIntervalFn = deps.setIntervalFn || setInterval;

  const tick = () => runPublishTick(db, deps).catch((err) => {
    console.error(`[XPublishSched] tick failed entirely: ${err.message}`);
  });

  if (deps.runNow) return tick();

  console.log(`[XPublishSched] started (warmup ${Math.round(warmupMs / 1000)}s, tick every ${Math.round(intervalMs / 1000)}s). Fires only rows whose approved schedule time has passed.`);

  const warmupTimer = setTimeoutFn(() => {
    tick();
    const intervalTimer = setIntervalFn(tick, intervalMs);
    if (intervalTimer && typeof intervalTimer.unref === 'function') intervalTimer.unref();
  }, warmupMs);
  if (warmupTimer && typeof warmupTimer.unref === 'function') warmupTimer.unref();
}

module.exports = {
  DEFAULT_WARMUP_MS,
  DEFAULT_INTERVAL_MS,
  startXPublishScheduler,
  runPublishTick,
  fireOne,
  fileFailureNotice,
};
