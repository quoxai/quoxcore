/**
 * QSKL-11a — Daily Skill-Decay Cron Scheduler
 *
 * Registers a daily cron that runs createSkillDecayCron(...).run() at 03:30 UTC
 * (offset 30 min from stale-flag job to avoid midnight pileups).
 *
 * Default-ON. Set QSKL_DECAY_DISABLED=true to disable.
 * Custom schedule via QSKL_DECAY_SCHEDULE (default: '30 3 * * *').
 */

import { Cron } from 'croner';
import type { SkillDecayCron } from '../agentic/skill-decay-cron.js';

const DEFAULT_SCHEDULE = '30 3 * * *'; // 03:30 UTC daily

export interface ScheduleSkillDecayDailyOpts {
  cron: SkillDecayCron;
  schedule?: string;
  /**
   * Whether to register the cron.
   * When omitted, reads env (default-on unless QSKL_DECAY_DISABLED=true).
   */
  enabled?: boolean;
  /** Override process.env for testing. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Register a daily cron job that runs the skill-decay sweep at 03:30 UTC.
 *
 * Returns the Cron instance when enabled, or null when disabled.
 * The caller (server.ts) is responsible for stopping it on SIGTERM if needed.
 */
export function scheduleSkillDecayDaily(opts: ScheduleSkillDecayDailyOpts): Cron | null {
  const env = opts.env ?? process.env;
  const schedule = opts.schedule ?? env.QSKL_DECAY_SCHEDULE ?? DEFAULT_SCHEDULE;

  // Default-ON: disabled ONLY when QSKL_DECAY_DISABLED is exactly 'true'.
  const enabled =
    opts.enabled !== undefined
      ? opts.enabled
      : env.QSKL_DECAY_DISABLED !== 'true';

  if (!enabled) {
    return null;
  }

  const cron = new Cron(schedule, { timezone: 'UTC' }, async () => {
    console.log(`[SkillDecayCron] Daily cron triggered at ${new Date().toISOString()}`);
    try {
      const result = await opts.cron.run();
      console.log(
        `[SkillDecayCron] Complete — ran=${result.ran} demoted=${result.demoted} archive_flagged=${result.archive_flagged}`,
      );
    } catch (err) {
      console.error('[SkillDecayCron] Job failed:', err instanceof Error ? err.message : err);
    }
  });

  console.log(`[SkillDecayCron] Daily cron scheduled at '${schedule}' (UTC)`);
  return cron;
}
