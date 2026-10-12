/**
 * QSKL-11b — Weekly Skill-Judge Cron Scheduler
 *
 * Registers a weekly cron that runs createSkillJudgeJob(...).run() at
 * Monday 04:00 UTC (30 minutes after daily skill-decay cron).
 *
 * Default-ON. Set QSKL_JUDGE_DISABLED=true to disable.
 * Custom schedule via QSKL_JUDGE_SCHEDULE (default: '0 4 * * 1').
 */

import { Cron } from 'croner';
import type { SkillJudgeJob } from '../agentic/skill-judge-job.js';

const DEFAULT_SCHEDULE = '0 4 * * 1';

export interface ScheduleSkillJudgeWeeklyOpts {
  job: SkillJudgeJob;
  schedule?: string;
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function scheduleSkillJudgeWeekly(opts: ScheduleSkillJudgeWeeklyOpts): Cron | null {
  const env = opts.env ?? process.env;
  const schedule = opts.schedule ?? env.QSKL_JUDGE_SCHEDULE ?? DEFAULT_SCHEDULE;
  const enabled = opts.enabled !== undefined ? opts.enabled : env.QSKL_JUDGE_DISABLED !== 'true';
  if (!enabled) return null;

  const cron = new Cron(schedule, { timezone: 'UTC' }, async () => {
    console.log(`[SkillJudgeCron] Weekly cron triggered at ${new Date().toISOString()}`);
    try {
      const result = await opts.job.run();
      console.log(`[SkillJudgeCron] Complete — ran=${result.ran} succeeded=${result.succeeded} failed=${result.failed} tokens=${result.total_tokens} cost=$${result.total_cost_usd.toFixed(4)}`);
    } catch (err) {
      console.error('[SkillJudgeCron] Job failed:', err instanceof Error ? err.message : err);
    }
  });
  console.log(`[SkillJudgeCron] Weekly cron scheduled at '${schedule}' (UTC)`);
  return cron;
}
