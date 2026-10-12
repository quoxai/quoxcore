-- Migration 015: Add org_id column to quox_skill_patches for per-org rate-limit isolation.
--
-- QSKL-FIX 3.1 Gap 2: quox_skill_patches was missing org_id, making the
-- rate-limiter (10/24h per agent per org) unable to enforce per-org isolation.
-- Without this column, org-A's 10 patches would silently block org-B's first patch.
--
-- DEFAULT 'org-default' is for backward-compat on zero existing production rows.
-- The default is dropped immediately after the ALTER so new inserts must supply org_id.

ALTER TABLE quox_skill_patches
  ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'org-default';

CREATE INDEX IF NOT EXISTS idx_quox_skill_patches_org_skill_time
  ON quox_skill_patches (org_id, skill_id, created_at DESC);

-- Drop the default so future inserts must provide an explicit org_id value.
ALTER TABLE quox_skill_patches
  ALTER COLUMN org_id DROP DEFAULT;
