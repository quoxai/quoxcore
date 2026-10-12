-- ============================================================================
-- Data Retention Schema
-- Security Issue #73: No data retention policy or automatic cleanup
-- ============================================================================
-- This schema adds:
-- 1. Instance-level retention configuration
-- 2. Org-level retention overrides
-- 3. User-level retention preferences
-- 4. Retention cleanup log for audit trail
-- ============================================================================

-- ============================================================================
-- RETENTION CONFIGURATION
-- ============================================================================

-- Instance-level retention defaults (stored in instance_config)
-- Added via INSERT OR IGNORE below

-- Org-level retention policies (can override instance defaults)
CREATE TABLE IF NOT EXISTS org_retention_policies (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL UNIQUE REFERENCES orgs(id) ON DELETE CASCADE,

    -- Data type retention periods (days, NULL = use instance default)
    audit_events_days INTEGER,              -- Audit log entries
    sessions_days INTEGER,                  -- Session records (expired/revoked)
    rate_limits_days INTEGER,               -- Rate limit records
    run_events_days INTEGER,                -- Workflow run events
    inbox_items_days INTEGER,               -- Resolved inbox items
    notification_deliveries_days INTEGER,   -- Notification delivery logs
    system_logs_days INTEGER,               -- System log entries
    api_key_access_days INTEGER,            -- API key access logs
    backup_audit_days INTEGER,              -- Backup audit logs
    artifacts_days INTEGER,                 -- Run artifacts (non-preserved)

    -- Enable/disable automatic cleanup
    auto_cleanup_enabled INTEGER NOT NULL DEFAULT 1,

    -- Custom data types (JSON for extensibility)
    -- Structure: { "custom_type_name": days }
    custom_retention_json TEXT DEFAULT '{}',

    -- Last cleanup info
    last_cleanup_at TEXT,
    last_cleanup_records INTEGER DEFAULT 0,

    -- Audit
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_org_retention_org ON org_retention_policies(org_id);

-- ============================================================================
-- USER RETENTION PREFERENCES
-- ============================================================================

-- Users can request shorter retention for their personal data
CREATE TABLE IF NOT EXISTS user_retention_preferences (
    id TEXT PRIMARY KEY,                    -- ULID
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

    -- Personal data retention (days, NULL = use org/instance default)
    -- Can only be equal to or shorter than org policy
    personal_data_days INTEGER,             -- User's own data
    session_history_days INTEGER,           -- Session history
    audit_events_days INTEGER,              -- Audit events where user is actor

    -- Request immediate deletion of specific data types
    -- JSON array of data types to delete on next cleanup
    pending_deletions_json TEXT DEFAULT '[]',

    -- Audit
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_retention_user ON user_retention_preferences(user_id);

-- ============================================================================
-- RETENTION CLEANUP LOG
-- ============================================================================

-- Audit trail for all cleanup operations
CREATE TABLE IF NOT EXISTS retention_cleanup_log (
    id TEXT PRIMARY KEY,                    -- ULID

    -- Scope of cleanup
    scope_type TEXT NOT NULL                -- 'instance', 'org', 'user'
        CHECK (scope_type IN ('instance', 'org', 'user')),
    scope_id TEXT,                          -- org_id or user_id (null for instance)

    -- Cleanup details
    data_type TEXT NOT NULL,                -- Table or data type cleaned
    retention_days INTEGER NOT NULL,        -- Policy applied
    cutoff_date TEXT NOT NULL,              -- Date cutoff used

    -- Results
    records_deleted INTEGER NOT NULL DEFAULT 0,
    bytes_freed INTEGER,                    -- Estimated bytes (if available)

    -- Status
    status TEXT NOT NULL DEFAULT 'completed'
        CHECK (status IN ('started', 'completed', 'failed', 'partial')),
    error_message TEXT,

    -- Timing
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    duration_ms INTEGER,

    -- Who/what triggered it
    triggered_by TEXT NOT NULL DEFAULT 'system'
        CHECK (triggered_by IN ('system', 'admin', 'user', 'schedule'))
);

CREATE INDEX IF NOT EXISTS idx_retention_log_scope ON retention_cleanup_log(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_retention_log_data_type ON retention_cleanup_log(data_type);
CREATE INDEX IF NOT EXISTS idx_retention_log_started ON retention_cleanup_log(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_retention_log_status ON retention_cleanup_log(status);

-- ============================================================================
-- INSTANCE RETENTION DEFAULTS
-- ============================================================================

-- Add default retention configuration to instance_config
INSERT OR IGNORE INTO instance_config (key, value, value_type, description) VALUES
    ('retention.default_days', '90', 'number', 'Default retention period in days for most data types'),
    ('retention.audit_events_days', '365', 'number', 'Retention period for audit events (compliance)'),
    ('retention.sessions_days', '30', 'number', 'Retention period for expired/revoked sessions'),
    ('retention.rate_limits_days', '7', 'number', 'Retention period for rate limit records'),
    ('retention.run_events_days', '90', 'number', 'Retention period for workflow run events'),
    ('retention.inbox_items_days', '90', 'number', 'Retention period for resolved inbox items'),
    ('retention.notification_deliveries_days', '30', 'number', 'Retention period for notification delivery logs'),
    ('retention.system_logs_days', '30', 'number', 'Retention period for system log entries'),
    ('retention.api_key_access_days', '90', 'number', 'Retention period for API key access logs'),
    ('retention.backup_audit_days', '365', 'number', 'Retention period for backup audit logs'),
    ('retention.artifacts_days', '30', 'number', 'Retention period for non-preserved artifacts'),
    ('retention.cleanup_enabled', 'true', 'boolean', 'Enable automatic data retention cleanup'),
    ('retention.cleanup_hour', '3', 'number', 'Hour of day to run cleanup (0-23, default 3 AM)'),
    ('retention.last_cleanup_at', '', 'string', 'Timestamp of last cleanup run'),
    ('retention.min_user_retention_days', '7', 'number', 'Minimum retention days users can request');

-- ============================================================================
-- TRIGGERS
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS org_retention_updated_at
    AFTER UPDATE ON org_retention_policies
    FOR EACH ROW
BEGIN
    UPDATE org_retention_policies SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS user_retention_updated_at
    AFTER UPDATE ON user_retention_preferences
    FOR EACH ROW
BEGIN
    UPDATE user_retention_preferences SET updated_at = datetime('now') WHERE id = NEW.id;
END;
