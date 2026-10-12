/**
 * QSKL-5.F — Daily Skill Tests Cron
 *
 * Runs author-written skill tests for all stable-edition skills daily at
 * 04:00 UTC (after the 03:00 validation suite).
 *
 * Enable by setting QUOXFLOW_SKILL_TESTS_CRON=true.
 *
 * Usage (one-shot manual run):
 *   QUOXFLOW_SKILL_TESTS_CRON=true npx tsx src/validation/skill-tests-scheduler.ts --once
 *
 * Usage (boot-time, env-gated from server.ts):
 *   QUOXFLOW_SKILL_TESTS_CRON=true DATABASE_URL=... node dist/server.js
 *   — server.ts calls scheduleSkillTestsDaily() which registers the cron job.
 */

import type { QuoxSkillsStore, QuoxSkillRecord } from '../store/quox-skills-store.js';
import type { SkillTestExecuteContext } from '../agentic/skill-test-runner.js';
import { runSkillTests } from '../agentic/skill-test-runner.js';
import { persistTestEvals } from '../agentic/skill-test-evals.js';
import { logger } from '../logger.js';

const log = logger.for('SkillTestsCron');

const CRON_SCHEDULE = '0 4 * * *'; // 04:00 UTC daily (after the 03:00 validation suite)

export interface RunStableSkillTestsOptions {
  store: QuoxSkillsStore;
  executeSkillContext?: SkillTestExecuteContext;
  /**
   * Optional: limit which orgs the cron sweeps, using QuoxSkillsStore.list()
   * per org. When omitted (the boot-time cron's default), the sweep runs
   * across ALL orgs via QuoxSkillsStore.listAllStableSkills() — the same
   * cross-org pattern used by the skill-decay and skill-judge crons.
   */
  orgIds?: string[];
}

export interface RunStableSkillTestsReport {
  startedAt: string;
  finishedAt: string;
  skillsScanned: number;
  skillsRun: number;
  skillsSkippedNoTests: number;
  drifters: Array<{ skillId: string; orgId: string; name: string; failed: number }>;
  errors: Array<{ skillId: string; message: string }>;
}

/**
 * Run stable skill tests once and return a report.
 *
 * SAFETY GATE: If executeSkillContext is absent, logs a clear warning and
 * returns a noop report without touching the store or marking any drifters.
 */
export async function runStableSkillTestsOnce(
  opts: RunStableSkillTestsOptions,
): Promise<RunStableSkillTestsReport> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // --- Safety gate: refuse to run without executor ---
  if (!opts.executeSkillContext) {
    log.warn(
      'no executeSkillContext wired; skipping. Set up the production engine or pass --ctx.',
    );
    const finishedAt = new Date().toISOString();
    return {
      startedAt,
      finishedAt,
      skillsScanned: 0,
      skillsRun: 0,
      skillsSkippedNoTests: 0,
      drifters: [],
      errors: [],
    };
  }

  // --- Gather the stable skills to sweep ---
  // Explicit orgIds (e.g. a scoped manual trigger) sweeps only those orgs via
  // list(). The boot-time cron omits orgIds and sweeps every org in one
  // cross-org query, mirroring the skill-decay / skill-judge crons.
  let stableSkills: QuoxSkillRecord[];
  if (opts.orgIds && opts.orgIds.length > 0) {
    const perOrg = await Promise.all(
      opts.orgIds.map(orgId => opts.store.list({ orgId, edition: 'stable' })),
    );
    stableSkills = perOrg.flat();
  } else {
    stableSkills = await opts.store.listAllStableSkills();
  }

  const drifters: RunStableSkillTestsReport['drifters'] = [];
  const errors: RunStableSkillTestsReport['errors'] = [];
  let skillsScanned = 0;
  let skillsRun = 0;
  let skillsSkippedNoTests = 0;

  for (const skill of stableSkills) {
    skillsScanned++;

    // Skip skills with no tests defined
    const tests = skill.tests as Record<string, unknown> | undefined;
    const hasTests = tests && typeof tests === 'object' && Object.keys(tests).length > 0;
    if (!hasTests) {
      skillsSkippedNoTests++;
      continue;
    }

    try {
      const result = await runSkillTests(skill, opts.executeSkillContext);
      await persistTestEvals(opts.store, skill.id, result);
      skillsRun++;

      if (result.failed > 0) {
        drifters.push({
          skillId: skill.id,
          orgId: skill.orgId,
          name: skill.name,
          failed: result.failed,
        });
      }
    } catch (err) {
      errors.push({
        skillId: skill.id,
        message: err instanceof Error ? err.message : String(err),
      });
      // Do NOT abort the sweep — continue with remaining skills
    }
  }

  const finishedAt = new Date().toISOString();
  const secs = ((Date.now() - startMs) / 1000).toFixed(1);

  const status =
    drifters.length === 0 && errors.length === 0
      ? 'GREEN'
      : errors.length > 0
        ? 'RED'
        : 'YELLOW';

  log.info(
    `${status} — scanned=${skillsScanned} run=${skillsRun} drifters=${drifters.length} errors=${errors.length} in ${secs}s`,
  );

  return {
    startedAt,
    finishedAt,
    skillsScanned,
    skillsRun,
    skillsSkippedNoTests,
    drifters,
    errors,
  };
}

/**
 * Register a daily cron job that runs stable skill tests at 04:00 UTC.
 *
 * Called from server.ts main() when QUOXFLOW_SKILL_TESTS_CRON=true.
 * Uses croner (already a quoxflow dep) so no extra package is required.
 *
 * Dynamic import ensures croner is only loaded when scheduling is enabled
 * (avoids pulling it into test bundles unnecessarily).
 */
export function scheduleSkillTestsDaily(
  opts: RunStableSkillTestsOptions & { schedule?: string },
): void {
  const schedule = opts.schedule ?? CRON_SCHEDULE;
  import('croner')
    .then(({ Cron }) => {
      new Cron(
        schedule,
        { timezone: 'UTC', name: 'quoxflow-skill-tests-daily' },
        async () => {
          log.info(`Daily cron triggered at ${new Date().toISOString()}`);
          await runStableSkillTestsOnce(opts);
        },
      );
      log.info(`Daily cron scheduled at '${schedule}' (UTC)`);
    })
    .catch(err => {
      log.error(
        'Failed to load croner for daily scheduling',
        { error: err instanceof Error ? err.message : String(err) },
      );
    });
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

const isOnce = process.argv.includes('--once');
const isBootGated = process.env.QUOXFLOW_SKILL_TESTS_CRON === 'true';

if (isOnce || isBootGated) {
  log.info(
    'Not started — no executeSkillContext available in CLI mode. Pass --ctx or wire production engine.',
  );
  if (isOnce) process.exit(0);
} else if (!isBootGated) {
  log.info(
    `Not started — set QUOXFLOW_SKILL_TESTS_CRON=true or pass --once.`,
  );
  log.info(`Daily cron schedule: ${CRON_SCHEDULE}`);
}
