/**
 * QSKL-7.6 — Daily Stale-Flag Job
 *
 * Walks skill_scoreboard and sets `evals.review_needed = true` when a skill
 * is underperforming (success_rate_7d < threshold AND invocations_7d >= min),
 * and CLEARS the flag when the metric recovers.
 *
 * Stale-flag rule:
 *   FLAG   when success_rate_7d < successThreshold AND total_invocations_7d >= minInvocations
 *   CLEAR  when success_rate_7d >= successThreshold OR  total_invocations_7d < minInvocations
 *
 * Best-effort: per-skill errors do not abort the job — they are accumulated
 * in the result's `errors` array.
 *
 * Idempotent: if the current evals state already matches the desired state
 * (review_needed already true/false), no write is issued.
 *
 * Exported function only — no scheduler. Register from server.ts or wire into
 * scheduleSkillStaleFlagDaily() (Slice 8) once the scheduler phase ships.
 */

import type { Pool } from 'pg';
import type { QuoxSkillsStore } from '../store/quox-skills-store.js';
import type { ScoreboardRow } from '../store/skill-scoreboard.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface StaleFlagJobOptions {
  pool: Pool;
  skillsStore: QuoxSkillsStore;
  /** REFRESH MATERIALIZED VIEW before reading. Default: true. */
  refreshFirst?: boolean;
  /** Minimum invocations in 7d window before the rate is considered reliable. Default: 5. */
  minInvocations?: number;
  /** success_rate_7d must be >= this to pass. Default: 0.7. */
  successThreshold?: number;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /**
   * Injectable scoreboard lister — used in tests to avoid DB.
   * Defaults to listSkillScoreboard(pool) from skill-scoreboard.ts.
   */
  listScoreboard?: (pool: Pool) => Promise<ScoreboardRow[]>;
  /**
   * Injectable scoreboard refresher — used in tests to avoid DB.
   * Defaults to refreshSkillScoreboard(pool) from skill-scoreboard.ts.
   */
  refreshScoreboard?: (pool: Pool) => Promise<void>;
}

export interface StaleFlagJobResult {
  skillsExamined: number;
  flaggedCount: number;
  clearedCount: number;
  errors: Array<{ skillId: string; error: string }>;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export async function runStaleFlagJob(opts: StaleFlagJobOptions): Promise<StaleFlagJobResult> {
  const {
    pool,
    skillsStore,
    refreshFirst = true,
    minInvocations = 5,
    successThreshold = 0.7,
    now = new Date(),
  } = opts;

  // Resolve injectable dependencies (real impls lazy-loaded to avoid circular deps)
  const doRefresh = opts.refreshScoreboard ?? (async (p: Pool) => {
    const { refreshSkillScoreboard } = await import('../store/skill-scoreboard.js');
    return refreshSkillScoreboard(p);
  });
  const doList = opts.listScoreboard ?? (async (p: Pool) => {
    const { listSkillScoreboard } = await import('../store/skill-scoreboard.js');
    return listSkillScoreboard(p);
  });

  // Optionally refresh the materialised view first
  if (refreshFirst) {
    await doRefresh(pool);
  }

  const rows = await doList(pool);

  const result: StaleFlagJobResult = {
    skillsExamined: rows.length,
    flaggedCount: 0,
    clearedCount: 0,
    errors: [],
  };

  for (const row of rows) {
    try {
      await processRow(row, {
        skillsStore,
        minInvocations,
        successThreshold,
        now,
        result,
      });
    } catch (err) {
      result.errors.push({
        skillId: row.skill_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface ProcessRowContext {
  skillsStore: QuoxSkillsStore;
  minInvocations: number;
  successThreshold: number;
  now: Date;
  result: StaleFlagJobResult;
}

async function processRow(row: ScoreboardRow, ctx: ProcessRowContext): Promise<void> {
  const { skillsStore, minInvocations, successThreshold, now, result } = ctx;

  const rate7d = Number(row.success_rate_7d);
  const invocations7d = Number(row.total_invocations_7d);

  // Determine desired flag state
  const shouldFlag = invocations7d >= minInvocations && rate7d < successThreshold;

  // Read current evals state
  const skill = await skillsStore.findByIdUnchecked(row.skill_id);
  const currentEvals = (skill?.evals ?? {}) as Record<string, unknown>;
  const currentReviewNeeded = Boolean(currentEvals.review_needed);

  if (shouldFlag && !currentReviewNeeded) {
    // Flag it — state change needed
    await skillsStore.updateEvals(row.skill_id, {
      review_needed: true,
      review_needed_reason: 'low_success_rate',
      review_needed_updated_at: now.toISOString(),
    });
    result.flaggedCount++;
  } else if (!shouldFlag && currentReviewNeeded) {
    // Clear it — was previously flagged, now recovered
    await skillsStore.updateEvals(row.skill_id, {
      review_needed: false,
      review_needed_reason: null,
      review_needed_updated_at: now.toISOString(),
    });
    result.clearedCount++;
  }
  // else: no change needed — idempotent skip
}
