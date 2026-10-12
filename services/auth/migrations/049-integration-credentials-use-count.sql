-- QuoxVault
ALTER TABLE integration_credentials ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
