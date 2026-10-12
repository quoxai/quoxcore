-- ============================================================================
-- Phase C.1: Human-in-the-Loop (HITL) Schema
-- ============================================================================
-- This schema adds:
-- 1. Workflow execution tracking (runs, run_events)
-- 2. Inbox system (inboxes, inbox_items, inbox_item_assignees)
-- 3. Routing and escalation (routing_rules, escalation_stages)
-- 4. Notification delivery (notification_channels, notification_deliveries)
-- 5. External integrations (integrations table extension)
-- ============================================================================

-- ============================================================================
-- 1. WORKFLOW EXECUTION TRACKING
-- ============================================================================

-- Workflow run instances
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,

    -- Status tracking
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'waiting_on_human', 'completed', 'failed', 'cancelled', 'expired')),

    -- Timing
    started_at TEXT,
    finished_at TEXT,

    -- Who initiated this run
    initiated_by_type TEXT NOT NULL DEFAULT 'user'
        CHECK (initiated_by_type IN ('user', 'service_account', 'schedule', 'webhook', 'system')),
    initiated_by_id TEXT,

    -- Runtime context and results
    context_json TEXT DEFAULT '{}',
    result_json TEXT,
    error_message TEXT,

    -- n8n integration
    n8n_execution_id TEXT,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runs_org ON runs(org_id);
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_initiated_by ON runs(initiated_by_type, initiated_by_id);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);

-- Run events (step execution log)
CREATE TABLE IF NOT EXISTS run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

    -- Event details
    step_idx INTEGER,
    event_type TEXT NOT NULL
        CHECK (event_type IN (
            'run_started', 'run_completed', 'run_failed', 'run_cancelled',
            'step_started', 'step_completed', 'step_failed', 'step_skipped',
            'human_requested', 'human_responded', 'human_timeout',
            'retry_scheduled', 'retry_started'
        )),

    -- Event payload
    payload_json TEXT DEFAULT '{}',

    -- Timestamp
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id);
CREATE INDEX IF NOT EXISTS idx_run_events_type ON run_events(event_type);
CREATE INDEX IF NOT EXISTS idx_run_events_created ON run_events(created_at);

-- ============================================================================
-- 2. INBOX SYSTEM
-- ============================================================================

-- Inboxes (work queues)
CREATE TABLE IF NOT EXISTS inboxes (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- Scope attachment (optional - for team/dept/div inboxes)
    scope_id TEXT REFERENCES scopes(id) ON DELETE SET NULL,

    -- Inbox type and ownership
    inbox_type TEXT NOT NULL DEFAULT 'personal'
        CHECK (inbox_type IN ('personal', 'team', 'scope')),
    name TEXT NOT NULL,

    -- Owner (for personal inboxes)
    owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,

    -- Settings
    settings_json TEXT DEFAULT '{}',

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inboxes_org ON inboxes(org_id);
CREATE INDEX IF NOT EXISTS idx_inboxes_owner ON inboxes(owner_id);
CREATE INDEX IF NOT EXISTS idx_inboxes_scope ON inboxes(scope_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inboxes_personal ON inboxes(org_id, owner_id) WHERE inbox_type = 'personal';

-- Inbox items (work objects)
CREATE TABLE IF NOT EXISTS inbox_items (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    inbox_id TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,

    -- Link to workflow run (if from a workflow)
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,

    -- Item classification
    kind TEXT NOT NULL DEFAULT 'task'
        CHECK (kind IN ('approval', 'question', 'task', 'incident', 'info', 'override_required')),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'in_progress', 'waiting', 'resolved', 'cancelled', 'expired')),
    priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),

    -- Content
    title TEXT NOT NULL,
    body_md TEXT,

    -- Structured payload (form schema, options, context)
    payload_json TEXT DEFAULT '{}',

    -- Response data (filled when resolved)
    response_json TEXT,

    -- SLA tracking
    due_at TEXT,
    sla_stages_json TEXT, -- Escalation stages config

    -- Tracking
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,

    -- Soft delete
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbox_items_org ON inbox_items(org_id);
CREATE INDEX IF NOT EXISTS idx_inbox_items_inbox ON inbox_items(inbox_id);
CREATE INDEX IF NOT EXISTS idx_inbox_items_run ON inbox_items(run_id);
CREATE INDEX IF NOT EXISTS idx_inbox_items_status ON inbox_items(status);
CREATE INDEX IF NOT EXISTS idx_inbox_items_kind ON inbox_items(kind);
CREATE INDEX IF NOT EXISTS idx_inbox_items_priority ON inbox_items(priority);
CREATE INDEX IF NOT EXISTS idx_inbox_items_due ON inbox_items(due_at);
CREATE INDEX IF NOT EXISTS idx_inbox_items_created ON inbox_items(created_at DESC);

-- Inbox item assignees (who can act on an item)
CREATE TABLE IF NOT EXISTS inbox_item_assignees (
    id TEXT PRIMARY KEY,
    inbox_item_id TEXT NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,

    -- Assignee (can be user, team, or role)
    assignee_type TEXT NOT NULL DEFAULT 'user'
        CHECK (assignee_type IN ('user', 'team', 'role')),
    assignee_id TEXT NOT NULL,

    -- Assignment mode
    mode TEXT NOT NULL DEFAULT 'anyone'
        CHECK (mode IN ('anyone', 'all', 'quorum')),
    quorum_count INTEGER, -- For quorum mode: how many must respond

    -- Response tracking
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'viewed', 'responded', 'delegated')),
    response_json TEXT,

    -- Timestamps
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    viewed_at TEXT,
    responded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbox_assignees_item ON inbox_item_assignees(inbox_item_id);
CREATE INDEX IF NOT EXISTS idx_inbox_assignees_assignee ON inbox_item_assignees(assignee_type, assignee_id);
CREATE INDEX IF NOT EXISTS idx_inbox_assignees_status ON inbox_item_assignees(status);

-- ============================================================================
-- 3. ROUTING AND ESCALATION
-- ============================================================================

-- Routing rules (determine where items go)
CREATE TABLE IF NOT EXISTS routing_rules (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- Scope (rules can be org-wide or scope-specific)
    scope_id TEXT REFERENCES scopes(id) ON DELETE CASCADE,

    -- Rule definition
    name TEXT NOT NULL,
    description TEXT,

    -- Match conditions (JSON: { kind, priority, workflow_id, tags, risk_level, etc. })
    match_json TEXT NOT NULL DEFAULT '{}',

    -- Route target (JSON: { inbox_id, team_id, role, user_ids, fallback, sla_minutes })
    route_json TEXT NOT NULL DEFAULT '{}',

    -- Priority (lower = evaluated first)
    priority INTEGER NOT NULL DEFAULT 100,

    -- Status
    enabled INTEGER NOT NULL DEFAULT 1,

    -- Tracking
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_routing_rules_org ON routing_rules(org_id);
CREATE INDEX IF NOT EXISTS idx_routing_rules_scope ON routing_rules(scope_id);
CREATE INDEX IF NOT EXISTS idx_routing_rules_priority ON routing_rules(priority);
CREATE INDEX IF NOT EXISTS idx_routing_rules_enabled ON routing_rules(enabled);

CREATE TABLE IF NOT EXISTS llm_routing_policies (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL UNIQUE REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_llm_routing_policies_org ON llm_routing_policies(org_id);
CREATE INDEX IF NOT EXISTS idx_llm_routing_policies_enabled ON llm_routing_policies(enabled);

-- Escalation stages (per inbox item)
CREATE TABLE IF NOT EXISTS escalation_stages (
    id TEXT PRIMARY KEY,
    inbox_item_id TEXT NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,

    -- Stage definition
    stage_num INTEGER NOT NULL,
    trigger_after_minutes INTEGER NOT NULL,

    -- Action to take
    action TEXT NOT NULL DEFAULT 'notify'
        CHECK (action IN ('notify', 'reassign', 'escalate', 'auto_approve', 'auto_deny', 'auto_expire')),

    -- Target (JSON: { user_ids, team_id, role, channels })
    target_json TEXT DEFAULT '{}',

    -- Execution tracking
    scheduled_at TEXT,
    triggered_at TEXT,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_escalation_item ON escalation_stages(inbox_item_id);
CREATE INDEX IF NOT EXISTS idx_escalation_scheduled ON escalation_stages(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_escalation_triggered ON escalation_stages(triggered_at);

-- ============================================================================
-- 4. NOTIFICATION SYSTEM
-- ============================================================================

-- User notification channel preferences
CREATE TABLE IF NOT EXISTS notification_channels (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Org scoping (multi-org support)
    org_id TEXT,

    -- Channel type
    channel_type TEXT NOT NULL
        CHECK (channel_type IN ('email', 'slack', 'telegram', 'in_app', 'webhook')),

    -- Enabled status
    enabled INTEGER NOT NULL DEFAULT 1,

    -- Channel-specific config (email address, slack user id, telegram chat id, etc.)
    config_json TEXT DEFAULT '{}',

    -- Preferences (quiet hours, filters, etc.)
    preferences_json TEXT DEFAULT '{}',

    -- Verification
    verified_at TEXT,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_channels_user_org_type ON notification_channels(user_id, channel_type, org_id);
CREATE INDEX IF NOT EXISTS idx_notification_channels_org ON notification_channels(org_id);
CREATE INDEX IF NOT EXISTS idx_notification_channels_enabled ON notification_channels(enabled);

-- Notification delivery log
CREATE TABLE IF NOT EXISTS notification_deliveries (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- What triggered this notification
    inbox_item_id TEXT REFERENCES inbox_items(id) ON DELETE SET NULL,
    escalation_stage_id TEXT REFERENCES escalation_stages(id) ON DELETE SET NULL,

    -- Delivery details
    channel_type TEXT NOT NULL
        CHECK (channel_type IN ('email', 'slack', 'telegram', 'in_app', 'webhook')),
    recipient TEXT NOT NULL, -- email address, user id, channel id, etc.

    -- Status tracking
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'bounced')),

    -- Delivery attempts
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_error TEXT,

    -- External reference (message id from provider)
    external_id TEXT,

    -- Content snapshot (for audit)
    content_json TEXT,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT,
    delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_org ON notification_deliveries(org_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_item ON notification_deliveries(inbox_item_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status ON notification_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_recipient ON notification_deliveries(recipient);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created ON notification_deliveries(created_at DESC);

-- ============================================================================
-- 5. INTEGRATIONS (Slack, Telegram, Email providers)
-- ============================================================================

-- External service integrations
CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- Integration type
    integration_type TEXT NOT NULL
        CHECK (integration_type IN ('slack', 'telegram', 'email', 'webhook', 'sms')),

    -- Display name
    name TEXT NOT NULL,

    -- Scope restriction (optional)
    scope_id TEXT REFERENCES scopes(id) ON DELETE SET NULL,

    -- Status
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('pending', 'active', 'disabled', 'error')),

    -- Credentials (reference to secrets table)
    secret_id TEXT REFERENCES secrets(id) ON DELETE SET NULL,

    -- Integration-specific config
    config_json TEXT DEFAULT '{}',

    -- For OAuth integrations
    oauth_state TEXT,
    oauth_expires_at TEXT,

    -- Error tracking
    last_error TEXT,
    last_error_at TEXT,

    -- Tracking
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integrations_org ON integrations(org_id);
CREATE INDEX IF NOT EXISTS idx_integrations_type ON integrations(integration_type);
CREATE INDEX IF NOT EXISTS idx_integrations_status ON integrations(status);
CREATE INDEX IF NOT EXISTS idx_integrations_scope ON integrations(scope_id);

-- ============================================================================
-- 6. ACTION TOKENS (for email/Slack approve buttons)
-- ============================================================================

-- Single-use action tokens
CREATE TABLE IF NOT EXISTS action_tokens (
    id TEXT PRIMARY KEY,

    -- What this token is for
    inbox_item_id TEXT NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
    assignee_id TEXT NOT NULL,

    -- Token hash (the actual token is sent to user, we store hash)
    token_hash TEXT NOT NULL UNIQUE,

    -- Allowed actions
    allowed_actions TEXT NOT NULL DEFAULT '["approve","deny"]', -- JSON array

    -- Expiration
    expires_at TEXT NOT NULL,

    -- Usage tracking
    used_at TEXT,
    used_action TEXT,
    used_ip TEXT,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_action_tokens_item ON action_tokens(inbox_item_id);
CREATE INDEX IF NOT EXISTS idx_action_tokens_hash ON action_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_action_tokens_expires ON action_tokens(expires_at);

-- ============================================================================
-- 7. AUDIT EVENTS FOR HITL
-- ============================================================================

-- Add HITL-specific audit event types (these will use existing audit_events table)
-- Event types to add:
--   hitl.item_created
--   hitl.item_assigned
--   hitl.item_viewed
--   hitl.item_responded
--   hitl.item_escalated
--   hitl.item_expired
--   hitl.item_cancelled
--   hitl.item_reassigned
--   run.started
--   run.completed
--   run.failed
--   run.cancelled
--   notification.sent
--   notification.failed

-- ============================================================================
-- 8. TRIGGERS FOR UPDATED_AT
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS runs_updated_at
    AFTER UPDATE ON runs
    FOR EACH ROW
BEGIN
    UPDATE runs SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS inboxes_updated_at
    AFTER UPDATE ON inboxes
    FOR EACH ROW
BEGIN
    UPDATE inboxes SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS inbox_items_updated_at
    AFTER UPDATE ON inbox_items
    FOR EACH ROW
BEGIN
    UPDATE inbox_items SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS routing_rules_updated_at
    AFTER UPDATE ON routing_rules
    FOR EACH ROW
BEGIN
    UPDATE routing_rules SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS notification_channels_updated_at
    AFTER UPDATE ON notification_channels
    FOR EACH ROW
BEGIN
    UPDATE notification_channels SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS integrations_updated_at
    AFTER UPDATE ON integrations
    FOR EACH ROW
BEGIN
    UPDATE integrations SET updated_at = datetime('now') WHERE id = NEW.id;
END;
