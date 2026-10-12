-- QuoxChat Schema (Stream CW-1)
-- Website chat widget management tables

-- Enable WAL mode for better concurrent write performance
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- Website widgets — each represents a deployable chat assistant
CREATE TABLE IF NOT EXISTS website_widgets (
    id TEXT PRIMARY KEY,
    assistant_id TEXT NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- Identity
    name TEXT NOT NULL,
    public_key TEXT UNIQUE NOT NULL,

    -- Domain security
    allowed_domains_json TEXT NOT NULL DEFAULT '[]',

    -- Deployment
    deployment_type TEXT NOT NULL DEFAULT 'embed',
    embed_config_json TEXT DEFAULT '{}',

    -- Knowledge
    knowledge_folder_path TEXT,
    qdrant_namespace TEXT,

    -- BYOK
    llm_key_vault_ref TEXT,

    -- Budget
    monthly_budget_cents INTEGER,
    budget_action TEXT DEFAULT 'downgrade',
    usage_this_month_json TEXT DEFAULT '{}',

    -- Stats (denormalised for fast reads)
    total_conversations INTEGER DEFAULT 0,
    total_messages INTEGER DEFAULT 0,
    last_conversation_at TEXT,

    -- Lifecycle
    status TEXT NOT NULL DEFAULT 'draft',
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    -- QCX-6c — per-widget retention. Null means use org default; 0 means
    -- no retention enforced; >0 prunes conversations older than N days.
    retention_days_override INTEGER,

    -- QCX-6d — EU AI Act risk classification (auto-applied on create/PATCH).
    risk_tier TEXT,
    risk_classification_json TEXT,

    -- QCL-IDENTITY P1 — HMAC secret used to verify a host-computed
    -- user_hash = HMAC-SHA256(user_id, identity_secret) on identify()
    -- calls. Generated at create time; see
    -- migrations/079-website-widgets-identity-secret.sql.
    identity_secret TEXT,

    -- CAPTCHA / bot-detection action gate (task #127) — OFF BY DEFAULT.
    -- Provider secret (reCAPTCHA/Turnstile) for server-side verification.
    -- Never echoed back to any client; public-safe fields (enabled,
    -- provider, site_key, min_score, guard) live in embed_config_json. See
    -- migrations/080-website-widgets-captcha-secret.sql.
    captcha_secret TEXT,

    -- QUOXCHAT-PRO P1 — org-configurable alerts + availability. See
    -- migrations/084-website-widgets-quoxchat-pro.sql for shapes.
    -- notification_settings_json is server-side only (contains operator
    -- emails / webhook URLs) and must never reach the widget-facing
    -- /quoxchat/config/:publicKey response.
    notification_settings_json TEXT,
    office_hours_json TEXT,
    operator_online INTEGER NOT NULL DEFAULT 1,

    UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_widgets_org ON website_widgets(org_id);
CREATE INDEX IF NOT EXISTS idx_widgets_public_key ON website_widgets(public_key);
CREATE INDEX IF NOT EXISTS idx_widgets_status ON website_widgets(org_id, status);

-- Widget knowledge sources — files, URLs, Q&A pairs, connectors
CREATE TABLE IF NOT EXISTS widget_knowledge_sources (
    id TEXT PRIMARY KEY,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,

    -- Source config
    source_type TEXT NOT NULL,
    name TEXT NOT NULL,
    config_json TEXT DEFAULT '{}',

    -- Indexing state
    status TEXT NOT NULL DEFAULT 'pending',
    chunk_count INTEGER DEFAULT 0,
    content_hash TEXT,
    error_message TEXT,

    -- Sync
    last_sync_at TEXT,
    sync_schedule TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_widget ON widget_knowledge_sources(widget_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_status ON widget_knowledge_sources(widget_id, status);

-- Widget conversations — visitor chat sessions
CREATE TABLE IF NOT EXISTS widget_conversations (
    id TEXT PRIMARY KEY,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,

    -- Visitor
    visitor_id TEXT NOT NULL,
    visitor_email TEXT,
    visitor_name TEXT,
    visitor_metadata_json TEXT DEFAULT '{}',

    -- State
    status TEXT NOT NULL DEFAULT 'active',
    resolution TEXT,
    message_count INTEGER DEFAULT 0,

    -- AEE
    correlation_id TEXT NOT NULL,

    -- Rating
    visitor_rating INTEGER,

    -- Timestamps
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_message_at TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_widget ON widget_conversations(widget_id);
CREATE INDEX IF NOT EXISTS idx_conversations_visitor ON widget_conversations(widget_id, visitor_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON widget_conversations(widget_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_date ON widget_conversations(widget_id, started_at);

-- Widget messages — individual chat messages
CREATE TABLE IF NOT EXISTS widget_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES widget_conversations(id) ON DELETE CASCADE,
    widget_id TEXT NOT NULL,

    -- Content
    role TEXT NOT NULL,
    content TEXT NOT NULL,

    -- RAG metadata
    sources_json TEXT,
    confidence REAL,

    -- Tool use
    tool_calls_json TEXT,

    -- AEE
    envelope_id TEXT,

    -- Security
    injection_score REAL DEFAULT 0,
    filtered INTEGER DEFAULT 0,

    -- QCX-5a: full LLM input context for admin root-cause drill-down.
    -- Nullable (user rows + pre-QCX-5a rows leave it NULL).
    context_json TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- QCX-5f — system prompt version history. Every PATCH that touches a
-- widget's system_prompt_override snapshots the previous value here so
-- admins can diff and one-click rollback.
CREATE TABLE IF NOT EXISTS widget_prompt_versions (
    id TEXT PRIMARY KEY,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    system_prompt TEXT,
    embed_config_json TEXT,
    change_note TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(widget_id, version)
);
CREATE INDEX IF NOT EXISTS idx_widget_prompt_versions_widget ON widget_prompt_versions(widget_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON widget_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_widget ON widget_messages(widget_id);
CREATE INDEX IF NOT EXISTS idx_messages_date ON widget_messages(widget_id, created_at);

-- Widget connectors — database, API, webhook, QuoxFlow bindings
CREATE TABLE IF NOT EXISTS widget_connectors (
    id TEXT PRIMARY KEY,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,

    -- Config
    connector_type TEXT NOT NULL,
    name TEXT NOT NULL,
    config_json TEXT DEFAULT '{}',
    vault_ref TEXT,

    -- State
    status TEXT NOT NULL DEFAULT 'active',
    last_used_at TEXT,
    use_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_connectors_widget ON widget_connectors(widget_id);
