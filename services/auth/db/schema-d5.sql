-- Phase D5: Scope-Channel Assignments
-- Maps which notification channels are enabled per org scope

CREATE TABLE IF NOT EXISTS scope_channel_assignments (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
    channel_type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(scope_id, channel_type)
);

CREATE INDEX IF NOT EXISTS idx_sca_org ON scope_channel_assignments(org_id);
CREATE INDEX IF NOT EXISTS idx_sca_scope ON scope_channel_assignments(scope_id);
CREATE INDEX IF NOT EXISTS idx_sca_channel ON scope_channel_assignments(channel_type);
CREATE INDEX IF NOT EXISTS idx_sca_scope_enabled ON scope_channel_assignments(scope_id, enabled);
