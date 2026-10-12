/**
 * Skill Scoreboard — QSKL-7 Slice 2
 *
 * Provides refresh and read access to the skill_scoreboard materialised view.
 * The view is created by migration 008-skill-scoreboard.sql and aggregates
 * per-skill telemetry from evidence records of type 'skill_invoked'.
 */

import { Pool } from 'pg';
import { SYSTEM_SCOPE, SystemScope } from '../api/middleware/org-scope.js';

/** Org scope accepted by readSkillScoreboard — string org id, or the explicit
 * cross-org SYSTEM_SCOPE sentinel (QF-MT WP7 — no longer an omittable param). */
export type ScoreboardOrgScope = string | SystemScope;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScoreboardRow {
  /** Added by migration 016 — org_id partitions the materialised view. */
  org_id?: string | null;
  skill_id: string;
  success_rate_30d: string | number;
  success_rate_7d: string | number;
  total_invocations_30d: number;
  total_invocations_7d: number;
  avg_cost_usd: string | number | null;
  avg_latency_ms: string | number | null;
  crystal_hit_rate: string | number;
  drift_trend: string | number | null;
  last_used_at: Date;
  refreshed_at: Date;
}

// ─── Functions ────────────────────────────────────────────────────────────────

/**
 * Refresh the skill_scoreboard materialised view by calling the
 * refresh_skill_scoreboard() SQL function.
 *
 * This is a thin wrapper so callers stay decoupled from the raw SQL.
 */
export async function refreshSkillScoreboard(pool: Pool): Promise<void> {
  await pool.query('SELECT refresh_skill_scoreboard()');
}

/**
 * List all rows from skill_scoreboard.
 * Returns an empty array when the view is empty.
 */
export async function listSkillScoreboard(pool: Pool): Promise<ScoreboardRow[]> {
  const result = await pool.query<ScoreboardRow>('SELECT * FROM skill_scoreboard');
  return result.rows;
}

/**
 * Read a single row from skill_scoreboard for the given skill_id, org-scoped.
 * Returns null when the skill has no recorded invocations (row not in view)
 * or when the skill does not belong to the caller's org.
 *
 * QF-MT WP7: scope is required — pass SYSTEM_SCOPE explicitly for the
 * legacy/admin path (skill-id-only, no org filter) instead of omitting the
 * argument.
 */
export async function readSkillScoreboard(
  pool: Pool,
  skillId: string,
  scope: ScoreboardOrgScope
): Promise<ScoreboardRow | null> {
  if (scope !== SYSTEM_SCOPE) {
    const result = await pool.query<ScoreboardRow>(
      'SELECT * FROM skill_scoreboard WHERE skill_id = $1 AND org_id = $2',
      [skillId, scope]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  }

  const result = await pool.query<ScoreboardRow>(
    'SELECT * FROM skill_scoreboard WHERE skill_id = $1',
    [skillId]
  );

  if (result.rows.length === 0) return null;
  return result.rows[0];
}
