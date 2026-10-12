-- Migration 021: Lineage graph columns on execution_history — MEM-DECAY MD.3
-- Adds parent_execution_id (self-referencing pointer to the prior run of the
-- same workflow), motivation (what the run was trying to do), and lesson
-- (a short natural-language takeaway written on failure by
-- src/pipeline/lineage-analyzer.ts). All three are nullable, UPDATE-only —
-- no backfill, no DELETE.
--
-- TRUST-GATE fresh-DB requirement (see migration-table-dependencies.test.ts /
-- the 004-skill-library-metadata.sql precedent, 2026-07-02): execution_history
-- was historically created only by runtime store code (CREATE TABLE IF NOT
-- EXISTS in src/store/execution-history-store.ts), never by an earlier
-- migration. Prepending the canonical CREATE TABLE (copied verbatim from
-- that store's init(), pre-lineage-column shape) makes this migration
-- self-sufficient on a genuinely fresh DB applying 001..021 in order.
--
-- Safe to re-run: all objects use IF NOT EXISTS / information_schema checks.

CREATE TABLE IF NOT EXISTS execution_history (
  id VARCHAR(26) PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id VARCHAR(255) NOT NULL,
  workflow_id VARCHAR(255) NOT NULL,
  exec_id VARCHAR(255) NOT NULL,
  success BOOLEAN NOT NULL,
  node_count INT,
  duration_ms BIGINT,
  action_log JSONB,
  node_types JSONB
);

CREATE INDEX IF NOT EXISTS idx_exec_history_org_workflow_ts
  ON execution_history(org_id, workflow_id, ts);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'execution_history' AND column_name = 'parent_execution_id'
  ) THEN
    ALTER TABLE execution_history ADD COLUMN parent_execution_id VARCHAR(26);
    CREATE INDEX idx_exec_history_parent_execution_id
      ON execution_history(parent_execution_id) WHERE parent_execution_id IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'execution_history' AND column_name = 'motivation'
  ) THEN
    ALTER TABLE execution_history ADD COLUMN motivation TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'execution_history' AND column_name = 'lesson'
  ) THEN
    ALTER TABLE execution_history ADD COLUMN lesson TEXT;
    -- Partial index: only lesson-bearing rows are ever queried (the
    -- forward-feed reads "last N non-null lessons for this workflow").
    CREATE INDEX idx_exec_history_lesson_present
      ON execution_history(org_id, workflow_id, ts DESC) WHERE lesson IS NOT NULL;
  END IF;
END $$;
