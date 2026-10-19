-- #1205: durable queue for the nightly self-verify (attempts, backoff, retirement).
CREATE TABLE IF NOT EXISTS backup_self_verify (
    backup_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',   -- pending | done | gave_up
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at TEXT NOT NULL DEFAULT (datetime('now')),  -- UTC, sqlite format
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backup_self_verify_due ON backup_self_verify(state, next_at);
