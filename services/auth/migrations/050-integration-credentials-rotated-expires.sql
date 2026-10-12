-- QuoxVault Phase 4
ALTER TABLE integration_credentials ADD COLUMN rotated_at TEXT;
ALTER TABLE integration_credentials ADD COLUMN expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_integration_credentials_expires ON integration_credentials(org_id, expires_at);
