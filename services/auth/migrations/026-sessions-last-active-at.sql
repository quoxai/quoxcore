-- ET-ENFORCE E: idle-timeout enforcement
ALTER TABLE sessions ADD COLUMN last_active_at TEXT;
