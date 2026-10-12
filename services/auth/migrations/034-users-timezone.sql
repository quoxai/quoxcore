-- Security Issue #57: GDPR account deletion support
ALTER TABLE users ADD COLUMN timezone TEXT;
