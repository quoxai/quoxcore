-- Security Issue #57: GDPR account deletion support
ALTER TABLE users ADD COLUMN metadata_json TEXT DEFAULT '{}';
