-- Migration 022: Precedent store — AOCL judgment-call precedent tracking.
--
-- Persists resolved judgment calls (HITL-resolved or agent-autonomous
-- disposition decisions) so future resolutions can cite, follow, or
-- distinguish them. Mirrors the skill_library pattern (pg.Pool +
-- in-memory fallback, ULID PK, canonical-hash + Ed25519 signature columns,
-- see skill-library-store.ts) — see src/store/precedent-store.ts.
--
-- fact_pattern_hash is a sha256 hex digest produced by hashSnapshot()
-- (src/store/crystal-canonical-hash.ts), reused verbatim from the Crystal
-- signing path so both stores hash facts the same deterministic way.
--
-- Fresh-DB self-sufficient (TRUST-GATE, see migration 021's precedent /
-- migration-table-dependencies.test.ts): table + indexes both created here.

CREATE TABLE IF NOT EXISTS precedent_store (
  id                    VARCHAR(26) PRIMARY KEY,
  org_id                VARCHAR(255) NOT NULL,
  fact_pattern          JSONB NOT NULL,
  fact_pattern_hash     TEXT NOT NULL,
  ratio                 TEXT NOT NULL,
  disposition           JSONB NOT NULL,
  authority             TEXT NOT NULL CHECK (authority IN ('agent-autonomous', 'hitl-approved', 'owner')),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'overruled', 'superseded')),
  overruled_by          VARCHAR(26),
  overrule_approval_id  VARCHAR(255),
  citation_count        INT NOT NULL DEFAULT 0,
  last_cited_at         TIMESTAMPTZ,
  -- Crystal-signing-oracle columns (mirrors skill_library: signature is
  -- computed over fact_pattern_hash, never leaves auth unsigned).
  canonical_hash        TEXT,
  signature             TEXT,
  signed_by             TEXT,
  sig_algorithm         TEXT,
  signed_at             TIMESTAMPTZ,
  signature_status      TEXT DEFAULT 'unsigned',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_precedent_store_org_hash
  ON precedent_store(org_id, fact_pattern_hash);

CREATE INDEX IF NOT EXISTS idx_precedent_store_org_status
  ON precedent_store(org_id, status);

CREATE INDEX IF NOT EXISTS idx_precedent_store_citation_rank
  ON precedent_store(org_id, status, citation_count DESC, last_cited_at DESC);
