-- Migration 005: Deduplicate canonical skill_library rows
-- AGH-1.fix: promoteCanonical was not idempotent — each engine restart + 3 successful
-- runs would insert a fresh canonical row instead of bumping the existing one.
-- This migration collapses duplicates per (org_id, source_workflow_id) keeping the
-- earliest created_at row and summing execution_counts across all duplicates.
--
-- Safe to re-run: the WITH clause finds groups with >1 canonical row; if there are none
-- the UPDATE and DELETE are no-ops.
--
-- Added 2026-05-10

DO $$
DECLARE
  affected_updates INTEGER;
  affected_deletes INTEGER;
BEGIN
  -- Step 1: For each (org_id, source_workflow_id) with >1 canonical row,
  -- update the keeper (earliest created_at) with the summed execution_count.
  WITH duplicates AS (
    SELECT
      id,
      org_id,
      source_workflow_id,
      created_at,
      execution_count,
      ROW_NUMBER() OVER (
        PARTITION BY org_id, source_workflow_id
        ORDER BY created_at ASC
      ) AS rn,
      SUM(execution_count) OVER (
        PARTITION BY org_id, source_workflow_id
      ) AS total_count
    FROM skill_library
    WHERE metadata->>'stage' = 'canonical'
  ),
  to_keep AS (
    SELECT id, total_count
    FROM duplicates
    WHERE rn = 1
      AND total_count > execution_count  -- only rows that have duplicates to absorb
  )
  UPDATE skill_library sl
  SET
    execution_count = tk.total_count,
    updated_at = NOW()
  FROM to_keep tk
  WHERE sl.id = tk.id;

  GET DIAGNOSTICS affected_updates = ROW_COUNT;

  -- Step 2: Delete all non-keeper canonical rows for groups that had duplicates.
  WITH duplicates AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY org_id, source_workflow_id
        ORDER BY created_at ASC
      ) AS rn
    FROM skill_library
    WHERE metadata->>'stage' = 'canonical'
  )
  DELETE FROM skill_library
  WHERE id IN (
    SELECT id FROM duplicates WHERE rn > 1
  );

  GET DIAGNOSTICS affected_deletes = ROW_COUNT;

  RAISE NOTICE 'Migration 005: updated % keeper rows, deleted % duplicate canonical rows',
    affected_updates, affected_deletes;
END $$;
