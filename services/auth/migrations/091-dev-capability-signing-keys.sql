-- 091-dev-capability-signing-keys.sql
-- DEVSUITE-HUB Phase 2 foundation: per-org dev capability profile signing
-- oracle (auth-side key custody).
--
-- Auth holds the org's Ed25519 "Dev Capability Signing Key" (DCSK) private
-- material (encrypted at rest under the vault master key via
-- utils/encryption.js encrypt()/decrypt() -- same v2 envelope used
-- everywhere else, including 077-org-crystal-signing-keys.sql). Auth is a
-- PURE SIGNING ORACLE: whatever issues a quoxagent dev.* CapabilityProfile
-- (internal/plugins/dev/profile.go) computes the exact canonical bytes
-- buildProfileSignedData() would produce and sends them here to be signed;
-- auth never parses or understands profile structure. The private key never
-- leaves this service.
--
-- This is a DEDICATED keypair, distinct from org_crystal_signing_keys --
-- never shared or referenced across the two tables.
--
-- Dev capability profiles are pinned to individual HOSTS within an org
-- (CapabilityProfile.HostID), but the signing KEY is per-ORG (one org, one
-- dev-signing keypair, used to sign profiles for any of that org's hosts);
-- HostID lives inside the signed payload, not in this table.
--
-- v1: one active key per org (UNIQUE(org_id, status) lets a future rotation
-- flow retire the old row to status='retired' and insert a fresh 'active'
-- one without violating the constraint).
CREATE TABLE IF NOT EXISTS dev_capability_signing_keys (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL,
  key_id                 TEXT NOT NULL UNIQUE,
  algorithm              TEXT NOT NULL DEFAULT 'Ed25519',
  public_key_hex         TEXT NOT NULL,
  private_key_encrypted  TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active',
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, status)
);

CREATE INDEX IF NOT EXISTS idx_dev_capability_signing_keys_org
  ON dev_capability_signing_keys(org_id);
