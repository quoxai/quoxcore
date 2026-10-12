-- 102-approval-grant-signing-keys.sql
-- TRUST-PROOF slice 4: per-org Ed25519 "Approval Grant Signing Key" (AGSK)
-- custody for QuoxBastion's X-Bastion-Approval-Grant gate (auth-side key
-- custody).
--
-- Auth holds the org's Ed25519 AGSK private material (encrypted at rest
-- under the vault master key via utils/encryption.js encrypt()/decrypt() --
-- same v2 envelope used everywhere else, including
-- 091-dev-capability-signing-keys.sql and 077-org-crystal-signing-keys.sql).
-- Auth mints and signs the canonical grant bytes for a HITL-approved
-- exec/tool action (lib/approvalGrant.js buildUnsignedGrant() +
-- signedBytes()) via routes/internal-approval-grants.js; the private key
-- never leaves this service. QuoxBastion's internal/approval package
-- verifies the resulting grant against this key's PUBLIC half only.
--
-- This is a DEDICATED keypair, distinct from org_crystal_signing_keys and
-- dev_capability_signing_keys -- never shared or referenced across tables.
--
-- v1: one active key per org (UNIQUE(org_id, status) lets a future rotation
-- flow retire the old row to status='retired' and insert a fresh 'active'
-- one without violating the constraint).
CREATE TABLE IF NOT EXISTS approval_grant_signing_keys (
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

CREATE INDEX IF NOT EXISTS idx_approval_grant_signing_keys_org
  ON approval_grant_signing_keys(org_id);
