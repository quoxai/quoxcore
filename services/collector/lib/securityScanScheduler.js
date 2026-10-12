'use strict';

/**
 * QUOX-SECURITY-SCHED Phase 2: the cadence loop itself.
 *
 * Deliberately NOT a durable queue-drain worker — this codebase has no such
 * thing, and this module must not invent one. It is only a server-side
 * setInterval that periodically asks securityEngagementSchedules for what's
 * due (listDueSchedules) and, for each due schedule, calls the EXISTING
 * async execution path (executeSecurityCapabilityToolAsync) exactly the way
 * the .../capability/:tool/start route already does. Same shape as the
 * compliance_jobs runner in server.js (setInterval, guarded, errors
 * isolated per-job).
 *
 * `executeAsync` is injected rather than imported directly so the loop can
 * be unit-tested with a fake and so production wiring (server.js) owns the
 * one adapter that maps this module's clean call shape onto
 * executeSecurityCapabilityToolAsync's real (name, input, ctx) signature —
 * see the adapter comment in server.js next to where this is constructed.
 */

const securityEngagementSchedules = require('./securityEngagementSchedules.js');

const DEFAULT_INTERVAL_MS = 60000;

function defaultNow() {
  return new Date().toISOString();
}

/**
 * @param {object} deps
 * @param {object} deps.db - the security.db handle
 * @param {(call: {engagementId:string, orgId:string, toolName:string, targetValue:string, scheduleId:string, createdBy:string}) => Promise<{job_id?:string, status?:string, allowed?:boolean, success?:boolean}>} deps.executeAsync
 *   Clean interface the scheduler calls. Production wiring adapts this onto
 *   executeSecurityCapabilityToolAsync; tests pass a fake directly.
 * @param {() => string} [deps.now] - ISO-8601 clock, defaults to the real clock. Test override.
 * @param {number} [deps.intervalMs] - tick interval, defaults to 60000.
 * @param {object} [deps.logger] - defaults to console. Needs .log/.error.
 */
function createSecurityScanScheduler(deps) {
  const { db, executeAsync } = deps || {};
  if (!db) throw new Error('createSecurityScanScheduler requires deps.db');
  if (typeof executeAsync !== 'function') throw new Error('createSecurityScanScheduler requires deps.executeAsync');

  const now = deps.now || defaultNow;
  const intervalMs = deps.intervalMs || DEFAULT_INTERVAL_MS;
  const logger = deps.logger || console;

  let timer = null;
  let ticking = false;

  /**
   * Runs one pass over every due schedule (cross-org, by design — this is
   * the internal scheduler side of listDueSchedules). Each schedule is
   * wrapped in its own try/catch: one schedule failing (executeAsync
   * throwing, or returning a denied/allowed:false result) must never stop
   * the loop or skip the other due schedules in the same tick, and must
   * never leave the schedule wedged — recordRun is called in every branch
   * so next_run_at always advances.
   *
   * @returns {Promise<{fired:number, errors:number, skipped?:boolean}>}
   */
  async function tickOnce() {
    if (ticking) {
      // Overlap guard: a slow prior tick is still in flight, skip this one
      // rather than firing the same due schedules twice.
      return { fired: 0, errors: 0, skipped: true };
    }
    ticking = true;
    let fired = 0;
    let errors = 0;

    try {
      const nowIso = now();
      const due = securityEngagementSchedules.listDueSchedules({ db, now }, nowIso);

      for (const schedule of due) {
        try {
          const result = await executeAsync({
            engagementId: schedule.engagement_id,
            orgId: schedule.org_id,
            toolName: schedule.tool,
            targetValue: schedule.target_value,
            scheduleId: schedule.id,
            createdBy: `schedule:${schedule.id}`,
          });

          const jobId = (result && result.job_id) || null;
          let status;
          if (result && result.allowed === false) {
            status = `denied: ${result.error || 'policy denied'}`;
          } else if (result && result.success === false) {
            status = `error: ${result.error || 'execution returned success:false'}`;
          } else {
            status = (result && result.status) || 'queued';
          }

          securityEngagementSchedules.recordRun(
            schedule.id,
            { job_id: jobId, status, ran_at: now() },
            { db, now }
          );
          fired += 1;
        } catch (err) {
          errors += 1;
          try {
            securityEngagementSchedules.recordRun(
              schedule.id,
              { job_id: null, status: `error: ${err.message}`, ran_at: now() },
              { db, now }
            );
          } catch (recordErr) {
            // recordRun itself failing is the one case we can't self-heal
            // (the schedule row may be gone); log loudly, next tick's
            // listDueSchedules will simply not see this schedule if it was
            // deleted, or will retry it if the failure was transient.
            logger.error(`[SecurityScanScheduler] failed to record run for schedule ${schedule.id}: ${recordErr.message}`);
          }
          logger.error(`[SecurityScanScheduler] schedule ${schedule.id} (${schedule.tool} -> ${schedule.target_value}) failed: ${err.message}`);
        }
      }
    } finally {
      ticking = false;
    }

    return { fired, errors };
  }

  function start() {
    if (timer) return;
    logger.log(`[SecurityScanScheduler] started, tick=${Math.round(intervalMs / 1000)}s`);
    timer = setInterval(() => {
      tickOnce().catch((err) => {
        logger.error(`[SecurityScanScheduler] tick error: ${err.message}`);
      });
    }, intervalMs);
    // Never hold the process open just for this timer (same discipline as
    // the other setInterval timers in server.js, e.g. complianceJobRunner).
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tickOnce };
}

module.exports = { createSecurityScanScheduler, DEFAULT_INTERVAL_MS };
