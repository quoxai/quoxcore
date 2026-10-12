-- Phase A.5: Instance Admin & Key Management Schema Additions
-- Run after initial schema.sql

-- ============================================================================
-- INSTANCE CONFIGURATION
-- ============================================================================

-- Instance-level configuration (singleton key-value store)
CREATE TABLE IF NOT EXISTS instance_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    value_type TEXT NOT NULL DEFAULT 'string',  -- string, json, boolean, number
    encrypted INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT REFERENCES users(id)
);

-- Default configuration values
INSERT OR IGNORE INTO instance_config (key, value, value_type, description) VALUES
    ('instance.name', 'Quox', 'string', 'Instance display name'),
    ('instance.setup_complete', 'false', 'boolean', 'Initial setup completed'),
    ('auth.allow_signup', 'true', 'boolean', 'Allow public signups'),
    ('auth.require_email_verification', 'true', 'boolean', 'Require email verification'),
    ('auth.allowed_email_domains', '[]', 'json', 'Restrict signups to domains (empty = all)'),
    ('keys.allow_org_override', 'true', 'boolean', 'Allow orgs to use their own API keys'),
    ('keys.allow_user_byok', 'true', 'boolean', 'Allow users to bring their own keys'),
    ('keys.default_provider', 'anthropic', 'string', 'Default AI provider'),
    ('orgs.allow_user_creation', 'false', 'boolean', 'Allow users to create orgs'),
    ('orgs.max_per_user', '3', 'number', 'Max orgs per user (if user creation allowed)'),
    ('auth.session_idle_minutes', '30', 'number', 'Idle session timeout in minutes (1–43200, capped at 30 days)'),
    ('auth.session_max_minutes', '720', 'number', 'Maximum session lifetime in minutes (1–129600, capped at 90 days)');

-- ============================================================================
-- INSTANCE ADMINISTRATORS
-- ============================================================================

-- Instance administrators (separate from org roles)
CREATE TABLE IF NOT EXISTS instance_admins (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'admin',  -- 'superadmin', 'admin', 'readonly'
    granted_by TEXT REFERENCES users(id),
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_instance_admins_user ON instance_admins(user_id);
CREATE INDEX IF NOT EXISTS idx_instance_admins_active ON instance_admins(user_id) WHERE revoked_at IS NULL;

-- ============================================================================
-- API KEYS (Multi-Level)
-- ============================================================================

-- API keys at any scope level (instance, org, team, user)
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,              -- 'instance', 'org', 'team', 'user'
    scope_id TEXT,                         -- null for instance, otherwise org_id/team_id/user_id
    provider TEXT NOT NULL,                -- 'anthropic', 'openai', 'elevenlabs', 'google', etc.
    name TEXT NOT NULL,                    -- Display name
    key_ciphertext TEXT NOT NULL,          -- Encrypted API key
    key_preview TEXT,                      -- Last 4 chars for identification (e.g., "...abc1")
    model_config_json TEXT DEFAULT '{}',   -- Provider-specific config (default model, etc.)
    is_default INTEGER NOT NULL DEFAULT 0, -- Default key for this provider at this scope
    is_active INTEGER NOT NULL DEFAULT 1,
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    last_error TEXT,                       -- Last error message if any
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(scope_type, scope_id, provider, name)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_scope ON api_keys(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys(provider, is_active);
CREATE INDEX IF NOT EXISTS idx_api_keys_default ON api_keys(scope_type, scope_id, provider, is_default) WHERE is_default = 1;

-- ============================================================================
-- KEY POLICIES
-- ============================================================================

-- Key resolution policies at each scope level
CREATE TABLE IF NOT EXISTS key_policies (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,              -- 'instance', 'org', 'team'
    scope_id TEXT,                         -- null for instance
    allow_child_override INTEGER NOT NULL DEFAULT 1,  -- Can child scopes override?
    allow_byok INTEGER NOT NULL DEFAULT 1, -- Can users bring their own keys?
    allowed_providers TEXT DEFAULT '[]',   -- JSON array of allowed providers (empty = all)
    blocked_providers TEXT DEFAULT '[]',   -- JSON array of blocked providers
    require_approval INTEGER NOT NULL DEFAULT 0,  -- Require admin approval for new keys?
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_key_policies_scope ON key_policies(scope_type, scope_id);

-- Default instance policy (allows everything)
INSERT OR IGNORE INTO key_policies (id, scope_type, scope_id, allow_child_override, allow_byok)
VALUES ('instance_default', 'instance', NULL, 1, 1);

-- ============================================================================
-- SYSTEM LOGS
-- ============================================================================

-- System logs (recent, for admin dashboard)
CREATE TABLE IF NOT EXISTS system_logs (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,                 -- 'auth', 'api', 'worker', 'n8n', etc.
    level TEXT NOT NULL,                   -- 'error', 'warn', 'info', 'debug'
    message TEXT NOT NULL,
    error_stack TEXT,
    request_id TEXT,                       -- Correlation ID
    user_id TEXT,                          -- User who triggered (if applicable)
    metadata_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_system_logs_service ON system_logs(service, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_time ON system_logs(created_at DESC);

-- ============================================================================
-- SERVICES REGISTRY
-- ============================================================================

-- Registered services for health monitoring
CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT,
    description TEXT,
    health_endpoint TEXT,                  -- URL to check health
    expected_port INTEGER,
    status TEXT NOT NULL DEFAULT 'unknown', -- 'healthy', 'unhealthy', 'unknown', 'disabled'
    status_message TEXT,
    last_check_at TEXT,
    last_healthy_at TEXT,
    check_interval_seconds INTEGER DEFAULT 60,
    config_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Default services
-- NOTE (2026-07 false-negative fix): these checks run server-side, inside
-- the `auth` container, via Node fetch() — so they must target the
-- docker-compose service DNS names on the shared quox-network (e.g.
-- `collector`, `qdrant`, `dashboard`), NOT `localhost` (which resolves to
-- the auth container itself) and NOT a dev-only port like Vite's 5173
-- (which doesn't exist in the production image at all). `auth` is the one
-- legitimate exception — it is checking itself, so localhost is correct.
-- N8N-ERADICATE: the 'n8n' row that used to be seeded here is gone — the n8n
-- service (and its with-n8n compose profile) no longer exists in this product,
-- so there is nothing left to health-check. OPTIONAL_SERVICE_IDS in
-- serviceHealthClassifier.js still names 'n8n' defensively, in case a
-- pre-existing install still carries a stale row from before this change.
INSERT OR IGNORE INTO services (id, name, display_name, description, health_endpoint, expected_port) VALUES
    ('auth', 'auth', 'Auth Service', 'Authentication and authorization', 'http://localhost:3101/health', 3101),
    ('collector', 'collector', 'MHA Collector', 'Agent fleet management', 'http://collector:9848/health', 9848),
    ('qdrant', 'qdrant', 'Qdrant Vector DB', 'Vector embeddings storage', 'http://qdrant:6333/healthz', 6333),
    ('dashboard', 'dashboard', 'Dashboard', 'Main web interface (nginx)', 'http://dashboard:80/health', 443);

-- ============================================================================
-- API KEY ACCESS LOG (for audit trail)
-- ============================================================================

CREATE TABLE IF NOT EXISTS api_key_access_log (
    id TEXT PRIMARY KEY,
    api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    accessed_by_type TEXT NOT NULL,        -- 'user', 'service_account', 'system'
    accessed_by_id TEXT NOT NULL,
    purpose TEXT,                          -- 'workflow_execution', 'chat', 'test', etc.
    run_id TEXT,                           -- Associated workflow run if applicable
    ip_address TEXT,
    success INTEGER NOT NULL DEFAULT 1,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_api_key_access_key ON api_key_access_log(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_key_access_user ON api_key_access_log(accessed_by_type, accessed_by_id, created_at DESC);
