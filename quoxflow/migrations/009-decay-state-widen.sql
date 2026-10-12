-- Migration 009: Widen quox_skills.decay_state — QSKL-11a
-- 'archive_candidate' (17 chars) overflows the original VARCHAR(16).
-- The 007 schema comment already documented this as a valid value; this is a width fix only.
-- Safe to re-run: idempotent via information_schema check.

DO $$
BEGIN
  IF (
    SELECT character_maximum_length
    FROM information_schema.columns
    WHERE table_name = 'quox_skills' AND column_name = 'decay_state'
  ) < 32 THEN
    ALTER TABLE quox_skills ALTER COLUMN decay_state TYPE VARCHAR(32);
  END IF;
END $$;
