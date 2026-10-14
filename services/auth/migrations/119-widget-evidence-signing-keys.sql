-- 119-widget-evidence-signing-keys.sql
-- Wave 11: per-org Ed25519 key for QuoxChat evidence bundles, so an auditor
-- can verify a bundle offline with the public key alone. Private key is
-- encrypted at rest via utils/encryption.js (see lib/widgetEvidenceSigningKey.js).
CREATE TABLE IF NOT EXISTS widget_evidence_signing_keys (
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

CREATE INDEX IF NOT EXISTS idx_widget_evidence_signing_keys_org
  ON widget_evidence_signing_keys(org_id);
