-- ============================================================================
-- Bastion HITL Schema: Pending Command Approvals
-- ============================================================================
-- This schema adds support for human-in-the-loop approvals for commands
-- executed through the SSH bastion. When a command matches a risk pattern,
-- it creates an approval request that must be resolved before execution.
-- ============================================================================

-- Pending command approvals (bastion HITL queue)
CREATE TABLE IF NOT EXISTS pending_command_approvals (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    inbox_item_id TEXT,
    host_id TEXT NOT NULL,
    host_name TEXT,
    command TEXT NOT NULL,
    command_hash TEXT NOT NULL,
    severity TEXT NOT NULL,
    pattern_description TEXT,
    requires_auth INTEGER NOT NULL DEFAULT 0,
    requested_by TEXT NOT NULL,
    requested_by_type TEXT NOT NULL DEFAULT 'user',
    source_context TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    responded_by TEXT,
    response_action TEXT,
    response_comment TEXT,
    execution_token TEXT,
    token_expires_at TEXT,
    token_used INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Index for looking up approvals by org
CREATE INDEX IF NOT EXISTS idx_pending_command_approvals_org
    ON pending_command_approvals(org_id);

-- Index for looking up approvals by status (pending, approved, denied, expired)
CREATE INDEX IF NOT EXISTS idx_pending_command_approvals_status
    ON pending_command_approvals(status);

-- Index for looking up approvals by host
CREATE INDEX IF NOT EXISTS idx_pending_command_approvals_host
    ON pending_command_approvals(host_id);

-- Index for looking up pending approvals by expiration (for cleanup jobs)
CREATE INDEX IF NOT EXISTS idx_pending_command_approvals_expires
    ON pending_command_approvals(expires_at);

-- Index for looking up approvals by requester
CREATE INDEX IF NOT EXISTS idx_pending_command_approvals_requested_by
    ON pending_command_approvals(requested_by);

-- Index for command hash lookups (deduplication, audit)
CREATE INDEX IF NOT EXISTS idx_pending_command_approvals_command_hash
    ON pending_command_approvals(command_hash);

-- Index for execution token lookups
CREATE INDEX IF NOT EXISTS idx_pending_command_approvals_token
    ON pending_command_approvals(execution_token);

-- Composite index for common query: pending approvals by org ordered by creation
CREATE INDEX IF NOT EXISTS idx_pending_command_approvals_org_status_created
    ON pending_command_approvals(org_id, status, created_at DESC);

-- Index for inbox item relationship
CREATE INDEX IF NOT EXISTS idx_pending_command_approvals_inbox_item
    ON pending_command_approvals(inbox_item_id);
