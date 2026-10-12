-- QuoxVault
ALTER TABLE integration_credentials ADD COLUMN lease_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE integration_credentials ADD COLUMN lease_max_duration_minutes INTEGER DEFAULT 120;
ALTER TABLE integration_credentials ADD COLUMN lease_max_uses INTEGER;
