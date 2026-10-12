/**
 * QSKL-SAFETY.E — Weekly Skill Safety-Judge Cron Scheduler
 *
 * Registers a weekly cron that runs createSkillSafetyJudgeJob(...).run() at
 * Tuesday 05:00 UTC — different day from skill-judge-job (Monday 04:00) to
 * spread load and avoid concurrent LLM-intense jobs.
 *
 * Default-ON. Set QSKL_SAFETY_JUDGE_DISABLED=true to disable.
 * Custom schedule via QSKL_SAFETY_JUDGE_SCHEDULE (default: '0 5 * * 2').
 */

import { Cron } from 'croner';
import type { SkillSafetyJudgeJob } from '../agentic/skill-safety-judge-job.js';

const DEFAULT_SCHEDULE = '0 5 * * 2'; // Tuesday 05:00 UTC

export interface ScheduleSkillSafetyJudgeWeeklyOpts {
  job: SkillSafetyJudgeJob;
  schedule?: string;
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function scheduleSkillSafetyJudgeWeekly(
  opts: ScheduleSkillSafetyJudgeWeeklyOpts
): Cron | null {
  const env = opts.env ?? process.env;
  const schedule = opts.schedule ?? env.QSKL_SAFETY_JUDGE_SCHEDULE ?? DEFAULT_SCHEDULE;
  const enabled =
    opts.enabled !== undefined ? opts.enabled : env.QSKL_SAFETY_JUDGE_DISABLED !== 'true';
  if (!enabled) return null;

  const cron = new Cron(schedule, { timezone: 'UTC' }, async () => {
    console.log(`[SkillSafetyJudgeCron] Weekly cron triggered at ${new Date().toISOString()}`);
    try {
      const result = await opts.job.run();
      console.log(
        `[SkillSafetyJudgeCron] Complete — ran=${result.ran} checked=${result.checked} ` +
          `queued=${result.queued} passed=${result.passed} errors=${result.errors} ` +
          `tokens=${result.total_tokens} cost=$${result.total_cost_usd.toFixed(4)}`
      );
    } catch (err) {
      console.error(
        '[SkillSafetyJudgeCron] Job failed:',
        err instanceof Error ? err.message : err
      );
    }
  });
  console.log(`[SkillSafetyJudgeCron] Weekly cron scheduled at '${schedule}' (UTC)`);
  return cron;
}
