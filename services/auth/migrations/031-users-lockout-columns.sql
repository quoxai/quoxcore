-- Security Issue #47: account lockout after failed logins
ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN lockout_until TEXT;
ALTER TABLE users ADD COLUMN last_failed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_users_lockout ON users(lockout_until);
