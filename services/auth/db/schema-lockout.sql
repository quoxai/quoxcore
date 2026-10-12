-- Account Lockout Migration
-- Security Issue #47: Add account lockout after failed logins

-- Add lockout columns to users table
ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN lockout_until TEXT;
ALTER TABLE users ADD COLUMN last_failed_at TEXT;

-- Index for efficient lockout queries
CREATE INDEX IF NOT EXISTS idx_users_lockout ON users(lockout_until);
