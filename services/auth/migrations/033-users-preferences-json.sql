-- Security Issue #57: GDPR account deletion support
ALTER TABLE users ADD COLUMN preferences_json TEXT DEFAULT '{}';
