/**
 * Issue #499 — Approval Expiry Scheduler
 *
 * Registers a recurring sweep that calls ApprovalEngine.processExpired() so
 * a pending approval past its expiresAt no longer sits pending forever.
 * Previously the only caller of processExpired() was the admin HTTP route
 * (POST /admin/expire) — nothing scheduled it.
 *
 * Loop-hygiene triad (see house rules — recurring loops must not silently
 * wedge or hot-loop on failure):
 *   (a) failure accounting DISTINCT from an empty (zero-expired) tick — a
 *       zero-expired tick is a success; an error is a failure, tracked
 *       separately with the error message retained.
 *   (b) capped backoff on consecutive failures — doubles the number of
 *       skipped ticks per consecutive failure, capped at maxBackoffTicks,
 *       and resets to zero on the next success.
 *   (c) natural retirement — processExpired() moves matched rows out of the
 *       'pending' status (approval-store.ts expireOld()), so a swept
 *       approval is never matched by a later sweep; verified in
 *       approval-expiry-scheduler.test.ts rather than re-implemented here.
 *
 * Default-ON. Set QUOXFLOW_APPROVAL_EXPIRY_DISABLED=true to disable.
 * Custom schedule via QUOXFLOW_APPROVAL_EXPIRY_SCHEDULE (default: every 5
 * minutes, matching the other maintenance sweeps' cadence).
 */

import { Cron } from 'croner';

const DEFAULT_SCHEDULE = '*/5 * * * *'; // every 5 minutes
const DEFAULT_MAX_BACKOFF_TICKS = 8; // cap: at most 8 skipped ticks (~40 min at the 5-min base) before retrying

export interface ApprovalExpiryEngine {
  processExpired(): Promise<number>;
}

export interface ApprovalExpirySchedulerStats {
  ticks: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  skippedForBackoff: number;
  lastError: string | null;
  lastExpiredCount: number | null;
}

export interface ScheduleApprovalExpirySweepOpts {
  engine: ApprovalExpiryEngine;
  schedule?: string;
  /** Whether to register the sweep. When omitted, reads env (default-on unless QUOXFLOW_APPROVAL_EXPIRY_DISABLED=true). */
  enabled?: boolean;
  /** Override process.env for testing. */
  env?: NodeJS.ProcessEnv;
  /** Max number of ticks to skip after consecutive failures (doubles per failure, capped here). Default 8. */
  maxBackoffTicks?: number;
  /** Test hook: called after every tick (including skipped ones) with the current stats snapshot. */
  onTick?: (stats: ApprovalExpirySchedulerStats) => void;
}

export interface ApprovalExpirySchedulerHandle {
  cron: Cron;
  stats: ApprovalExpirySchedulerStats;
  stop: () => void;
}

// Guard against double-registration (e.g. an accidental second call from
// server.ts). A single process runs a single sweep; a second call returns
// the handle already in flight instead of starting a competing timer.
let activeHandle: ApprovalExpirySchedulerHandle | null = null;

/**
 * Register a recurring sweep that runs ApprovalEngine.processExpired().
 *
 * Returns the scheduler handle when enabled, or null when disabled. The
 * caller (server.ts) is responsible for calling handle.stop() on shutdown.
 */
export function scheduleApprovalExpirySweep(
  opts: ScheduleApprovalExpirySweepOpts,
): ApprovalExpirySchedulerHandle | null {
  const env = opts.env ?? process.env;
  const schedule = opts.schedule ?? env.QUOXFLOW_APPROVAL_EXPIRY_SCHEDULE ?? DEFAULT_SCHEDULE;
  const maxBackoffTicks = opts.maxBackoffTicks ?? DEFAULT_MAX_BACKOFF_TICKS;

  // Default-ON: disabled ONLY when QUOXFLOW_APPROVAL_EXPIRY_DISABLED is exactly 'true'.
  const enabled =
    opts.enabled !== undefined ? opts.enabled : env.QUOXFLOW_APPROVAL_EXPIRY_DISABLED !== 'true';

  if (!enabled) {
    return null;
  }

  if (activeHandle) {
    return activeHandle;
  }

  const stats: ApprovalExpirySchedulerStats = {
    ticks: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    skippedForBackoff: 0,
    lastError: null,
    lastExpiredCount: null,
  };

  let skipTicksRemaining = 0;

  const cron = new Cron(schedule, { timezone: 'UTC' }, async () => {
    stats.ticks++;

    if (skipTicksRemaining > 0) {
      skipTicksRemaining--;
      stats.skippedForBackoff++;
      console.warn(
        `[ApprovalExpiryScheduler] tick skipped (backing off after ${stats.consecutiveFailures} consecutive failures, ${skipTicksRemaining} ticks remaining)`,
      );
      opts.onTick?.({ ...stats });
      return;
    }

    try {
      const expiredCount = await opts.engine.processExpired();
      stats.successes++;
      stats.consecutiveFailures = 0;
      stats.lastExpiredCount = expiredCount;
      stats.lastError = null;
      if (expiredCount > 0) {
        console.log(`[ApprovalExpiryScheduler] tick complete — expired=${expiredCount}`);
      }
    } catch (err) {
      stats.failures++;
      stats.consecutiveFailures++;
      stats.lastError = err instanceof Error ? err.message : String(err);
      const backoffTicks = Math.min(2 ** (stats.consecutiveFailures - 1), maxBackoffTicks);
      skipTicksRemaining = backoffTicks;
      console.error(
        `[ApprovalExpiryScheduler] tick failed (consecutiveFailures=${stats.consecutiveFailures}, backing off ${backoffTicks} ticks): ${stats.lastError}`,
      );
    }

    opts.onTick?.({ ...stats });
  });

  console.log(`[ApprovalExpiryScheduler] sweep scheduled at '${schedule}' (UTC)`);

  const handle: ApprovalExpirySchedulerHandle = {
    cron,
    stats,
    stop: () => {
      cron.stop();
      if (activeHandle === handle) {
        activeHandle = null;
      }
    },
  };

  activeHandle = handle;
  return handle;
}

/** Test-only: clears the double-registration guard between test cases. */
export function __resetApprovalExpirySchedulerForTests(): void {
  if (activeHandle) {
    activeHandle.stop();
  }
  activeHandle = null;
}
