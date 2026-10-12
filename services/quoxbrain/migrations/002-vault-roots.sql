-- 002-vault-roots.sql — QUOXBRAIN R2 per-org vault-root scoping
-- (STREAM_QUOXBRAIN_P1_CONTRACT.md §5, roadmap QUOXBRAIN #163)
--
-- Additive only — nothing dropped, nothing in 000-baseline.sql /
-- 001-chunks.sql touched.
--
-- Prior to R2, resolveSafeVaultPath() validated only that a source_path was
-- under the single GLOBAL QUOXBRAIN_VAULT_ROOT — any org could register a
-- vault under any other org's subdir and read their files through their own
-- org's rows. This table binds explicit additional roots to org_id; the
-- default convention (every org implicitly owns <QUOXBRAIN_VAULT_ROOT>/
-- <org_id>, no row needed) lives in lib/vaultRoot.js orgAllowedRoots().
--
-- `restricted` is reserved for a later ACL tier (funding/voice/email-style
-- vaults needing extra gating) — the column is set here but NOT enforced
-- until a later phase.

CREATE TABLE IF NOT EXISTS org_vault_roots (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  root_path  TEXT NOT NULL,
  restricted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(org_id, root_path)
);
CREATE INDEX IF NOT EXISTS idx_vault_roots_org ON org_vault_roots(org_id);
