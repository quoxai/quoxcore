-- Migration 023: Skill pack store — DEVSUITE-SKILLS Phase 1 (pack format + signing).
--
-- A "Dev Skills Pack" is a curated, versioned, signed bundle of references
-- to skill/rule content (skill name / file path / rule snippet id) — the
-- pack does NOT embed the skill/rule text itself. Persists the pack
-- manifest + the crystal-signing-oracle result for it (mirrors precedent_store
-- / skill_library: canonical_hash + Ed25519 signature columns, see
-- src/store/skill-pack-store.ts). Signing reuses the SAME per-org auth
-- signing oracle as Crystals and Precedents (POST
-- /api/internal/crystals/sign is a generic hash-signing endpoint, not
-- crystal-specific — see skill-pack-store.ts header comment).
--
-- Fresh-DB self-sufficient (TRUST-GATE, see migration 021/022's precedent /
-- migration-table-dependencies.test.ts): table + indexes both created here.

CREATE TABLE IF NOT EXISTS skill_pack (
  id                    VARCHAR(26) PRIMARY KEY,
  org_id                VARCHAR(255) NOT NULL,
  pack_version          TEXT NOT NULL,
  manifest              JSONB NOT NULL,
  canonical_hash        TEXT NOT NULL,
  signature             TEXT,
  signed_by             TEXT,
  sig_algorithm         TEXT,
  signed_at             TIMESTAMPTZ,
  signature_status      TEXT DEFAULT 'unsigned',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skill_pack_org
  ON skill_pack(org_id);

CREATE INDEX IF NOT EXISTS idx_skill_pack_org_created
  ON skill_pack(org_id, created_at DESC);
