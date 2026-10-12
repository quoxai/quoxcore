-- QCL-IDENTITY P1: per-widget secret used to verify a host-computed
-- user_hash = HMAC-SHA256(user_id, identity_secret) on QuoxChat.identify()
-- calls (Intercom-style visitor identity verification). Generated
-- (crypto.randomBytes(32).toString('hex')) at widget-create time; existing
-- rows without one are backfilled by
-- legacyDataMigrations.backfillWidgetIdentitySecrets() at boot.
ALTER TABLE website_widgets ADD COLUMN identity_secret TEXT;
