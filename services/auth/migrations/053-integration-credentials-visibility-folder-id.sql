-- QuoxVault
ALTER TABLE integration_credentials ADD COLUMN visibility TEXT NOT NULL DEFAULT 'org';
ALTER TABLE integration_credentials ADD COLUMN folder_id TEXT;
