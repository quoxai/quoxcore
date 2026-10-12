/**
 * QSKL-7.8 — Daily Stale-Flag Cron Scheduler
 *
 * Registers a daily cron job that runs runStaleFlagJob for all skills
 * at 03:00 UTC.
 *
 * Runs by default. Set QSKL_STALE_FLAG_JOB_ENABLED=false to disable.
 *
 * Custom schedule via QSKL_STALE_FLAG_SCHEDULE (default: '0 3 * * *').
 *
 * Usage (boot-time, from server.ts):
 *   scheduleSkillStaleFlagDaily({ pool, skillsStore })
 *   — returns a Cron instance (or null if disabled).
 */

import type { Pool } from 'pg';
import type { QuoxSkillsStore } from '../store/quox-skills-store.js';
import { runStaleFlagJob } from '../agentic/skill-stale-flag-job.js';
import { Cron } from 'croner';

const DEFAULT_SCHEDULE = '0 3 * * *'; // 03:00 UTC daily

export interface ScheduleSkillStaleFlagDailyOpts {
  pool: Pool;
  skillsStore: QuoxSkillsStore;
  /** Cron schedule string. Default: '0 3 * * *'. */
  schedule?: string;
  /**
   * Whether to register the cron.
   * When omitted, reads QSKL_STALE_FLAG_JOB_ENABLED env var:
   *   - defaults to enabled (true) unless set to exactly 'false'.
   * Pass false explicitly to disable regardless of env.
   */
  enabled?: boolean;
}

/**
 * Register a daily cron job that runs the stale-flag sweep at 03:00 UTC.
 *
 * Returns the Cron instance when enabled, or null when disabled.
 * The caller (server.ts) is responsible for stopping it on SIGTERM if needed.
 */
export function scheduleSkillStaleFlagDaily(
  opts: ScheduleSkillStaleFlagDailyOpts,
): Cron | null {
  const {
    pool,
    skillsStore,
    schedule = DEFAULT_SCHEDULE,
  } = opts;

  // Default ON: run unless env var is explicitly 'false'.
  const enabled =
    opts.enabled !== undefined
      ? opts.enabled
      : process.env.QSKL_STALE_FLAG_JOB_ENABLED !== 'false';

  if (!enabled) {
    return null;
  }

  const cron = new Cron(
    schedule,
    { timezone: 'UTC' },
    async () => {
      console.log(`[StaleFlagCron] Daily cron triggered at ${new Date().toISOString()}`);
      try {
        const result = await runStaleFlagJob({ pool, skillsStore });
        console.log(
          `[StaleFlagCron] Complete — examined=${result.skillsExamined} flagged=${result.flaggedCount} cleared=${result.clearedCount} errors=${result.errors.length}`,
        );
      } catch (err) {
        console.error('[StaleFlagCron] Job failed:', err instanceof Error ? err.message : err);
      }
    },
  );

  console.log(`[StaleFlagCron] Daily cron scheduled at '${schedule}' (UTC)`);
  return cron;
}
