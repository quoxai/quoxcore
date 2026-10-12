-- ============================================================================
-- System Maintenance: Update Tracking Schema
-- Phase D.2: Version checks, update operations, and settings
-- ============================================================================

-- Track version checks against GitHub releases
CREATE TABLE IF NOT EXISTS update_checks (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    current_version TEXT NOT NULL,
    available_version TEXT,
    update_available INTEGER DEFAULT 0,
    release_notes_md TEXT,
    published_at TEXT,
    release_url TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_update_checks_org ON update_checks(org_id);
CREATE INDEX IF NOT EXISTS idx_update_checks_checked ON update_checks(checked_at DESC);

-- Track update operations (install, rollback)
CREATE TABLE IF NOT EXISTS update_operations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    from_version TEXT NOT NULL,
    to_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'rolling_back', 'rolled_back')),
    pre_update_backup_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,
    current_step TEXT,
    steps_json TEXT,
    error_message TEXT,
    error_step TEXT,
    performed_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_update_ops_org ON update_operations(org_id);
CREATE INDEX IF NOT EXISTS idx_update_ops_status ON update_operations(status);
CREATE INDEX IF NOT EXISTS idx_update_ops_created ON update_operations(created_at DESC);

-- Per-org update settings
CREATE TABLE IF NOT EXISTS update_settings (
    org_id TEXT PRIMARY KEY,
    auto_check_enabled INTEGER DEFAULT 1,
    check_interval_hours INTEGER DEFAULT 6,
    auto_backup_before_update INTEGER DEFAULT 1,
    maintenance_window_enabled INTEGER DEFAULT 0,
    maintenance_day INTEGER,
    maintenance_hour INTEGER,
    notification_lead_hours INTEGER DEFAULT 24,
    release_channel TEXT DEFAULT 'stable'
        CHECK (release_channel IN ('stable', 'beta', 'nightly')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
