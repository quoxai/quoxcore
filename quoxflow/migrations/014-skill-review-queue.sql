-- Migration 014: skill_review_queue
-- QSKL-SAFETY.E — LLM-judge review queue
--
-- Stores one row per (skill_id, version) pair awaiting or having completed
-- safety review. The UNIQUE constraint enforces idempotency: re-running the
-- safety judge within the window does ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS skill_review_queue (
  id              TEXT PRIMARY KEY,                          -- ULID
  skill_id        TEXT NOT NULL,
  version         TEXT NOT NULL,
  org_id          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',           -- pending | approved | rejected
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  judge_run_id    TEXT,
  findings        JSONB NOT NULL DEFAULT '[]'::jsonb,
  rubric_scores   JSONB,
  rubric_version  INTEGER NOT NULL DEFAULT 1,
  cost_usd        NUMERIC,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  reviewer_id     TEXT,
  decision_at     TIMESTAMPTZ,
  comment         TEXT,
  UNIQUE(skill_id, version)
);

CREATE INDEX IF NOT EXISTS idx_skill_review_queue_status_queued
  ON skill_review_queue (status, queued_at);

CREATE INDEX IF NOT EXISTS idx_skill_review_queue_org_status
  ON skill_review_queue (org_id, status);

CREATE INDEX IF NOT EXISTS idx_skill_review_queue_skill_queued
  ON skill_review_queue (skill_id, queued_at DESC);
