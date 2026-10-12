-- Migration 006: Persistent crystal_drafts and consecutive_success_counters
-- AGH-4: Drafts and consecutiveSuccess counters now survive engine restarts.
-- Previously these lived in in-memory Maps that wiped on restart, forcing the
-- LLM to re-propose from scratch and wasting 3 runs of effort re-accumulating
-- the counter on an already-proven pattern.
--
-- Safe to re-run: all objects use IF NOT EXISTS.
-- Added 2026-05-09

CREATE TABLE IF NOT EXISTS crystal_drafts (
  execution_id            VARCHAR(255) PRIMARY KEY,
  org_id                  VARCHAR(255) NOT NULL,
  agent_id                VARCHAR(255),
  name                    TEXT NOT NULL,
  summary                 TEXT NOT NULL,
  action_pattern          TEXT NOT NULL,
  confidence              REAL NOT NULL,
  refine_count            INTEGER NOT NULL DEFAULT 0,
  consecutive_success     INTEGER NOT NULL DEFAULT 0,
  action_log_snapshot     JSONB,
  objective_keywords      JSONB DEFAULT '[]'::jsonb,
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crystal_drafts_pattern_key
  ON crystal_drafts (org_id, agent_id, action_pattern);

-- ConsecutiveSuccess counters: pattern-keyed running totals
-- Key format: "${agentId}::${orgId}::${actionPattern}" (normalised)
CREATE TABLE IF NOT EXISTS consecutive_success_counters (
  pattern_key             VARCHAR(512) PRIMARY KEY,
  count                   INTEGER NOT NULL DEFAULT 0,
  updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
