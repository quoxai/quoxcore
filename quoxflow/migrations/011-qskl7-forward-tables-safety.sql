-- Migration 011: idempotent re-creation of QSKL-7 forward-ref tables — QSKL-11b safety net.
-- Migration 007 declared these tables but in some deploys only quox_skills was actually applied.
-- Live verification of QSKL-11b's judge job hit "relation quox_skill_invocations does not exist"
-- because the drift dimension reads from this table. This migration ensures all forward-ref
-- tables exist; CREATE TABLE IF NOT EXISTS makes it safe to re-run.

CREATE TABLE IF NOT EXISTS quox_skill_patches (
  id                      VARCHAR(26) PRIMARY KEY,
  skill_id                VARCHAR(26) NOT NULL REFERENCES quox_skills(id),
  from_version            VARCHAR(16) NOT NULL,
  to_version              VARCHAR(16) NOT NULL,
  patched_by              VARCHAR(255) NOT NULL,
  reason                  TEXT,
  diff                    JSONB NOT NULL,
  tests_run               INT DEFAULT 0,
  tests_passed            INT DEFAULT 0,
  crystals_evaluated      INT DEFAULT 0,
  crystals_passed         INT DEFAULT 0,
  crystals_failed         JSONB DEFAULT '[]'::jsonb,
  outcome                 VARCHAR(16) NOT NULL,
  envelope_id             VARCHAR(26),
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quox_skill_patches_skill   ON quox_skill_patches (skill_id);
CREATE INDEX IF NOT EXISTS idx_quox_skill_patches_outcome ON quox_skill_patches (outcome);

CREATE TABLE IF NOT EXISTS quox_skill_invocations (
  id                      VARCHAR(26) PRIMARY KEY,
  skill_id                VARCHAR(26) NOT NULL REFERENCES quox_skills(id),
  skill_version           VARCHAR(16) NOT NULL,
  agent_id                VARCHAR(64) NOT NULL,
  session_id              VARCHAR(26),
  org_id                  VARCHAR(255) NOT NULL,
  crystal_id              VARCHAR(26),
  tokens_used             INT,
  cost_usd                NUMERIC(10, 6),
  latency_ms              INT,
  success                 BOOLEAN,
  drift_score             NUMERIC(5, 4),
  envelope_id             VARCHAR(26),
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quox_skill_invocations_skill  ON quox_skill_invocations (skill_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quox_skill_invocations_agent  ON quox_skill_invocations (agent_id);
CREATE INDEX IF NOT EXISTS idx_quox_skill_invocations_org    ON quox_skill_invocations (org_id);

CREATE TABLE IF NOT EXISTS quox_skill_publications (
  id                      VARCHAR(26) PRIMARY KEY,
  skill_id                VARCHAR(26) NOT NULL REFERENCES quox_skills(id),
  curator_index           VARCHAR(255) NOT NULL,
  published_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  signature               TEXT NOT NULL,
  safety_review_envelope  VARCHAR(26),
  judge_score             NUMERIC(3, 2),
  status                  VARCHAR(16) DEFAULT 'pending',
  recall_reason           TEXT,
  telemetry_optin         BOOLEAN DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_quox_skill_publications_skill ON quox_skill_publications (skill_id);

CREATE TABLE IF NOT EXISTS quox_capability_broadcasts (
  id                      VARCHAR(26) PRIMARY KEY,
  org_id                  VARCHAR(255) NOT NULL,
  requesting_agent        VARCHAR(64) NOT NULL,
  description             TEXT NOT NULL,
  responding_agents       JSONB DEFAULT '[]'::jsonb,
  selected_agent          VARCHAR(64),
  selected_skill          VARCHAR(26),
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quox_capability_broadcasts_org ON quox_capability_broadcasts (org_id, created_at);
