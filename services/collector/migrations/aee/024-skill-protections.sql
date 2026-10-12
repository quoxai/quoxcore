-- 024-skill-protections.sql — collector AEE database (aee.db)
--
-- SKILLRIGHTS #478 Phase 10 (`quox skills protect`, moat 1). The org's
-- durable record of each governed skill protection: the SkillRights
-- manifest hash the org signed (via the auth-side org signing oracle,
-- domain-separated digest), the open-registry SRID + full verified receipt,
-- and the AEE envelope id whose WARD witness anchors it in the org's
-- evidence chain. The registry receipt is stored whole so the org can prove
-- the registration offline even if registry.skillrights.org disappears.
--
-- UNIQUE(org_id, manifest_sha256): protecting identical content twice is
-- idempotent (returns the existing protection), matching the
-- skills.fromExecution precedent.

CREATE TABLE IF NOT EXISTS skill_protections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  srid TEXT NOT NULL,
  skill_name TEXT,
  manifest_sha256 TEXT NOT NULL,
  license TEXT,
  mode TEXT NOT NULL,
  org_key_id TEXT,
  org_signature_hex TEXT NOT NULL,
  org_public_key_hex TEXT,
  protect_digest TEXT NOT NULL,
  registry_url TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  supersedes TEXT,
  aee_envelope_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_protections_org_manifest
  ON skill_protections(org_id, manifest_sha256);
CREATE INDEX IF NOT EXISTS idx_skill_protections_org_created
  ON skill_protections(org_id, created_at);
