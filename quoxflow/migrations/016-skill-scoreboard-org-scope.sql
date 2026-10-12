-- Migration 016: Skill Scoreboard — org_id partitioning (QSKL-FIX Slice 4)
--
-- Problem: migration 008 created skill_scoreboard with GROUP BY skill_id only.
--   Cross-org invocations for the same skill_id are aggregated together, leaking
--   org-A's stats to org-B and vice versa. The scoreboard route returned combined
--   totals to any authenticated user who knew the skill_id.
--
-- Fix: Recreate the view with (org_id, skill_id) in the GROUP BY so each org
--   gets its own aggregated row. The route now passes orgId from the JWT and the
--   reader filters WHERE org_id = $1 AND skill_id = $2.
--
-- Safe to re-run: DROP IF EXISTS + CREATE ... IF NOT EXISTS guards all objects.

-- ─── Drop existing view and dependent objects ─────────────────────────────────

DROP MATERIALIZED VIEW IF EXISTS skill_scoreboard CASCADE;

-- ─── Recreate with org_id column ─────────────────────────────────────────────

CREATE MATERIALIZED VIEW skill_scoreboard AS
SELECT
  org_id,
  skill_id,

  -- 30-day window aggregates
  COALESCE(
    SUM(CASE
      WHEN created_at > NOW() - INTERVAL '30 days'
        AND success = TRUE
      THEN 1 ELSE 0
    END)::numeric
    /
    NULLIF(SUM(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END), 0),
    0
  )                                                               AS success_rate_30d,

  -- 7-day window aggregates
  COALESCE(
    SUM(CASE
      WHEN created_at > NOW() - INTERVAL '7 days'
        AND success = TRUE
      THEN 1 ELSE 0
    END)::numeric
    /
    NULLIF(SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END), 0),
    0
  )                                                               AS success_rate_7d,

  -- Invocation counts
  SUM(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END)::integer
                                                                  AS total_invocations_30d,
  SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END)::integer
                                                                  AS total_invocations_7d,

  -- Cost and latency (30d)
  AVG(
    CASE WHEN created_at > NOW() - INTERVAL '30 days'
    THEN cost_usd END
  )                                                               AS avg_cost_usd,

  AVG(
    CASE WHEN created_at > NOW() - INTERVAL '30 days'
    THEN latency_ms END
  )                                                               AS avg_latency_ms,

  -- Crystal hit rate (30d): fraction where crystal_id is non-null
  COALESCE(
    SUM(CASE
      WHEN created_at > NOW() - INTERVAL '30 days'
        AND crystal_id IS NOT NULL
      THEN 1 ELSE 0
    END)::numeric
    /
    NULLIF(SUM(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END), 0),
    0
  )                                                               AS crystal_hit_rate,

  -- Drift trend (30d): AVG of drift_score
  AVG(
    CASE WHEN created_at > NOW() - INTERVAL '30 days'
    THEN drift_score END
  )                                                               AS drift_trend,

  -- Timestamps
  MAX(created_at)                                                 AS last_used_at,
  NOW()                                                           AS refreshed_at

FROM quox_skill_invocations
GROUP BY org_id, skill_id;

-- ─── Unique index (required for REFRESH CONCURRENTLY) ────────────────────────
-- Changed from (skill_id) to (org_id, skill_id) — the unique unit is now per-org.

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_scoreboard_org_skill
  ON skill_scoreboard (org_id, skill_id);

CREATE INDEX IF NOT EXISTS idx_skill_scoreboard_skill_id
  ON skill_scoreboard (skill_id);

-- ─── Refresh function ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION refresh_skill_scoreboard()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY skill_scoreboard;
END;
$$;
