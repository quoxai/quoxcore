-- Migration 004: Add metadata column to skill_library table
-- Required for P9.1 crystal applicability filtering (agentId, objectiveKeywords)
-- Added 2026-05-08
--
-- TRUST-GATE fresh-DB fix (2026-07-02): skill_library was historically
-- created only by runtime store code (CREATE TABLE IF NOT EXISTS in
-- src/store/skill-library-store.ts), never by an earlier migration. On dev
-- DBs the runtime had already created the table before this migration ever
-- ran, so the gap was invisible. A genuinely fresh DB applies 001-003 then
-- dies here with "relation skill_library does not exist". Prepending the
-- canonical CREATE TABLE (copied verbatim from skill-library-store.ts, incl.
-- the metadata column so both paths converge) makes this migration
-- self-sufficient. Safe to re-run: CREATE TABLE/INDEX use IF NOT EXISTS and
-- the ALTER uses ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS skill_library (
  id VARCHAR(26) PRIMARY KEY,
  org_id VARCHAR(255) NOT NULL,
  source_workflow_id VARCHAR(255) NOT NULL,
  name TEXT NOT NULL,
  version INT NOT NULL,
  confidence REAL NOT NULL,
  execution_count INT NOT NULL,
  success_rate REAL NOT NULL,
  workflow_json JSONB NOT NULL,
  tags JSONB,
  variables JSONB,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, source_workflow_id, version)
);

CREATE INDEX IF NOT EXISTS idx_skill_library_org_source
  ON skill_library(org_id, source_workflow_id);

ALTER TABLE skill_library ADD COLUMN IF NOT EXISTS metadata JSONB;
