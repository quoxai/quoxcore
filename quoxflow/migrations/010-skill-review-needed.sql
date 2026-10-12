-- Migration 010: review_needed flag for skills judged with rolling 4-week avg < 3.0 — QSKL-11b
-- Idempotent: safe to re-run via information_schema check.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'quox_skills' AND column_name = 'review_needed'
  ) THEN
    ALTER TABLE quox_skills ADD COLUMN review_needed BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX idx_quox_skills_review_needed
      ON quox_skills(review_needed) WHERE review_needed = true;
  END IF;
END $$;
