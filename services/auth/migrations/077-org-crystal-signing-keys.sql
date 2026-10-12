-- 077-org-crystal-signing-keys.sql
-- REPLAY-ONLY .B1a: per-org crystal signing oracle (auth-side key custody).
--
-- Auth holds the org's Ed25519 "Crystal Signing Key" (CSK) private material
-- (encrypted at rest under the vault master key via utils/encryption.js
-- encrypt()/decrypt() — same v2 envelope used everywhere else). Auth is a
-- PURE SIGNING ORACLE: quoxflow computes the canonical hash of a crystal's
-- action snapshot and sends the opaque hash bytes here to be signed; auth
-- never parses or understands crystal structure. The private key never
-- leaves this service.
--
-- v1: one active key per org (UNIQUE(org_id, status) lets a future rotation
-- flow retire the old row to status='retired' and insert a fresh 'active'
-- one without violating the constraint).
CREATE TABLE IF NOT EXISTS org_crystal_signing_keys (
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

CREATE INDEX IF NOT EXISTS idx_org_crystal_signing_keys_org
  ON org_crystal_signing_keys(org_id);
