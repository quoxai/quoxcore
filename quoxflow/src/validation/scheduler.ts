/**
 * Validation Scheduler
 *
 * Cron entrypoint for the nightly Engine Validation Suite.
 *
 * CRON SCHEDULE: 0 3 * * * (03:00 UTC nightly)
 * Enable by setting QUOXFLOW_VALIDATION_SUITE=true.
 *
 * Usage (one-shot manual run):
 *   npx tsx src/validation/scheduler.ts --once
 *
 * Usage (boot-time, env-gated from server.ts):
 *   QUOXFLOW_VALIDATION_SUITE=true DATABASE_URL=... node dist/server.js
 *   — server.ts calls scheduleNightly() which registers the cron job.
 */

import { runAll } from './index.js';
import { persistReport } from './reporter.js';
import { logger } from '../logger.js';

const log = logger.for('ValidationSuite');

const CRON_SCHEDULE = '0 3 * * *'; // 03:00 UTC nightly

/**
 * Run the full validation suite once and persist the NightlyReport.
 * Logs a summary to stdout. Returns the report.
 */
export async function runOnce(opts?: { useRealLlm?: boolean }): Promise<void> {
  const startMs = Date.now();
  log.info(`Starting run at ${new Date().toISOString()}`);

  try {
    const report = await runAll({ useRealLlm: opts?.useRealLlm ?? false });
    await persistReport(report);

    const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
    const status = report.passed === report.totalAgents ? 'GREEN' : 'RED';

    log.info(`${status} — ${report.passed}/${report.totalAgents} passed in ${durationSec}s`);
    for (const r of report.results) {
      const icon = r.passed ? '✓' : '✗';
      log.debug(`  ${icon} ${r.id} ${r.name} (${r.durationMs}ms)${r.failureReason ? ` — ${r.failureReason}` : ''}`);
    }
    log.info(`Envelope intents observed: ${report.envelopeIntents.join(', ')}`);
  } catch (err: any) {
    log.error(`Fatal error: ${err.message}`);
    process.exit(1);
  }
}

// ─── Server-wirable cron function (R5.high-4) ────────────────────────────────

/**
 * Register a nightly cron job that runs the validation suite at 03:00 UTC.
 *
 * Called from server.ts main() when QUOXFLOW_VALIDATION_SUITE=true.
 * Uses croner (already a quoxflow dep) so no extra package is required.
 *
 * For testing: pass a custom schedule string (e.g. '* * * * *' to fire every
 * minute) or mock the croner module.
 */
export function scheduleNightly(opts?: { schedule?: string }): void {
  const schedule = opts?.schedule ?? CRON_SCHEDULE;
  // Dynamic import ensures croner is only loaded when scheduling is enabled
  // (avoids pulling it into test bundles unnecessarily).
  import('croner').then(({ Cron }) => {
    new Cron(schedule, { timezone: 'UTC', name: 'quoxflow-validation-nightly' }, async () => {
      log.info(`Nightly cron triggered at ${new Date().toISOString()}`);
      await runOnce({ useRealLlm: false });
    });
    log.info(`Nightly cron scheduled at '${schedule}' (UTC)`);
  }).catch(err => {
    log.error('Failed to load croner for nightly scheduling', { error: err instanceof Error ? err.message : String(err) });
  });
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

const isOnce = process.argv.includes('--once');
const isRealLlm = process.argv.includes('--real-llm');
const isBootGated = process.env.QUOXFLOW_VALIDATION_SUITE === 'true';

if (isOnce || isBootGated) {
  runOnce({ useRealLlm: isRealLlm }).then(() => {
    // Exit cleanly after one-shot run
    if (isOnce) process.exit(0);
  });
} else if (!isBootGated) {
  log.info(
    `Not started — set QUOXFLOW_VALIDATION_SUITE=true or pass --once.`
  );
  log.info(`Nightly cron schedule: ${CRON_SCHEDULE}`);
}
