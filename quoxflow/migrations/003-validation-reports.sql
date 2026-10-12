-- Migration 003: Engine Validation Reports
-- STUDY-REV-2 P8.E — Nightly validation suite persistence
--
-- Stores the last N NightlyReport records so that:
--   GET /api/validation/nightly  returns the last 30
--   GET /api/validation/streak   counts consecutive all-passed nights

CREATE TABLE IF NOT EXISTS validation_reports (
  id            VARCHAR(26)   PRIMARY KEY,
  ran_at        TIMESTAMPTZ   NOT NULL,
  total_agents  INT           NOT NULL DEFAULT 5,
  passed        INT           NOT NULL DEFAULT 0,
  failed        INT           NOT NULL DEFAULT 0,
  results_json  JSONB         NOT NULL,
  envelope_intents JSONB      NOT NULL DEFAULT '[]',
  total_tokens_in   BIGINT    NOT NULL DEFAULT 0,
  total_cost_usd_micro BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_validation_reports_ran_at
  ON validation_reports(ran_at DESC);
