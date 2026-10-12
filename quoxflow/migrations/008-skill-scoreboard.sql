-- Migration 008: Skill Scoreboard — QSKL-7 Slice 2 (re-targeted in Slice 3)
-- Materialised view aggregating per-skill telemetry from the typed
-- quox_skill_invocations table (not the generic evidence table).
-- Using typed columns removes JSON casts and produces cleaner aggregation.
--
-- Safe to re-run: all objects use IF NOT EXISTS / OR REPLACE.
-- Added 2026-05-12 (QSKL-7.2); re-targeted to quox_skill_invocations in QSKL-7.3.

-- ─── Materialised view ───────────────────────────────────────────────────────

CREATE MATERIALIZED VIEW IF NOT EXISTS skill_scoreboard AS
SELECT
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

  -- Drift trend (30d): AVG of drift_score — null in v0 when all scores are null
  AVG(
    CASE WHEN created_at > NOW() - INTERVAL '30 days'
    THEN drift_score END
  )                                                               AS drift_trend,

  -- Timestamps
  MAX(created_at)                                                 AS last_used_at,
  NOW()                                                           AS refreshed_at

FROM quox_skill_invocations
GROUP BY skill_id;

-- ─── Unique index (required for REFRESH CONCURRENTLY) ────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_scoreboard_skill_id
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
