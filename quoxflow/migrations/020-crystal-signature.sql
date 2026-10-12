-- Migration 020: Crystal action-snapshot signing columns — REPLAY-ONLY .B2
--
-- Adds signature storage to skill_library so promoteCanonical can call the
-- auth signing oracle (POST /api/internal/crystals/sign, shipped in .B1a)
-- at promotion time and persist the result. skill_library is created by
-- migration 004-skill-library-metadata.sql (CREATE TABLE IF NOT EXISTS) —
-- this migration only ALTERs it, which is safe because 004 always applies
-- first (lexicographic order) and the fresh-DB migration-dependency test
-- (migration-table-dependencies.test.ts) verifies exactly this.
--
-- signature_status:
--   'unsigned' — legacy rows, and rows promoted with no crystalSigner
--                injected at all (e.g. some test/embedded contexts)
--   'pending'  — canonical_hash was computed but the crystalSigner call
--                failed or returned null (e.g. auth outage). Promotion is
--                NOT blocked (resilient), but Slice B3's verify-on-replay
--                gate MUST treat this as unsigned (fail-closed under
--                replay-only)
--   'signed'   — signature / signed_by / sig_algorithm / signed_at are all
--                populated from a successful auth signing-oracle response
--
-- canonical_hash is stored in both the 'pending' and 'signed' cases so a
-- later re-sign attempt can confirm the action_log_snapshot has not changed
-- since promotion.

ALTER TABLE skill_library ADD COLUMN IF NOT EXISTS signature TEXT;
ALTER TABLE skill_library ADD COLUMN IF NOT EXISTS signed_by TEXT;
ALTER TABLE skill_library ADD COLUMN IF NOT EXISTS sig_algorithm TEXT;
ALTER TABLE skill_library ADD COLUMN IF NOT EXISTS canonical_hash TEXT;
ALTER TABLE skill_library ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;
ALTER TABLE skill_library ADD COLUMN IF NOT EXISTS signature_status TEXT DEFAULT 'unsigned';
