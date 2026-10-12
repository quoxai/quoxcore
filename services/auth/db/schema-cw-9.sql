-- CW-9.1 — Widget Tools
-- Tool = LLM-callable function, optionally backed by a widget_connectors row.
-- One connector can power many tools (e.g. one DB connector → get_order_status, list_invoices, …).
-- Tools with tool_type='builtin' have no connector (lead_capture, human_handoff, redirect_url).

CREATE TABLE IF NOT EXISTS widget_tools (
    id TEXT PRIMARY KEY,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    connector_id TEXT REFERENCES widget_connectors(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,

    -- Identity (name is what the LLM sees as function name)
    name TEXT NOT NULL,
    description TEXT,

    -- Classification
    tool_type TEXT NOT NULL DEFAULT 'connector', -- 'connector' | 'builtin'
    -- builtin_kind (when tool_type='builtin') — validated by BUILTIN_KINDS in
    -- routes/widget-connectors.js (the effective CHECK; keep both in sync):
    --   'lead_capture' | 'human_handoff' | 'redirect_url' | 'email_transcript'
    -- | 'book_demo' | 'create_ticket' | 'send_resource'
    -- | 'book_appointment' | 'schedule_demo' | 'leave_message'  (PRO-3 action catalog)
    builtin_kind TEXT,

    -- LLM function schema + backing config
    parameters_json TEXT NOT NULL DEFAULT '{"type":"object","properties":{}}',
    config_json TEXT NOT NULL DEFAULT '{}',

    -- State
    status TEXT NOT NULL DEFAULT 'active',        -- 'active' | 'disabled'
    last_used_at TEXT,
    use_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,

    -- Rate limits (per-session throttle, null = unlimited)
    rate_limit_per_session INTEGER,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(widget_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tools_widget ON widget_tools(widget_id);
CREATE INDEX IF NOT EXISTS idx_tools_connector ON widget_tools(connector_id);
CREATE INDEX IF NOT EXISTS idx_tools_status ON widget_tools(widget_id, status);

-- CW-9.3 — Widget Leads
-- Captured by the lead_capture builtin tool. One row per capture event.
-- Dashboard surfaces them under each widget; pipeline status (new/contacted/qualified/closed)
-- will grow as CRM integrations land. UNIQUE(widget_id, email, conversation_id) prevents
-- the LLM from registering duplicate leads inside a single conversation.

CREATE TABLE IF NOT EXISTS widget_leads (
    id TEXT PRIMARY KEY,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,
    conversation_id TEXT REFERENCES widget_conversations(id) ON DELETE SET NULL,
    visitor_id TEXT,

    name TEXT,
    email TEXT,
    phone TEXT,
    company TEXT,
    notes TEXT,

    -- Free-form metadata from the tool call (source page, UTM, etc.)
    metadata_json TEXT NOT NULL DEFAULT '{}',

    status TEXT NOT NULL DEFAULT 'new', -- 'new' | 'contacted' | 'qualified' | 'closed'
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(widget_id, email, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_leads_widget ON widget_leads(widget_id);
CREATE INDEX IF NOT EXISTS idx_leads_conversation ON widget_leads(conversation_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON widget_leads(widget_id, status);
