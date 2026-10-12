-- 000-baseline.sql — auth service versioned migration runner
--
-- The CURRENT complete schema, wrapped in idempotent CREATE ... IF NOT
-- EXISTS form so a genuinely FRESH database builds cleanly from migrations
-- alone. On an EXISTING database (tables already present, e.g. the live
-- auth.db), every statement below is a no-op — nothing is dropped or
-- recreated.
--
-- Body = schema.sql + every schema-*.sql file that db/index.js's old
-- applyMigrations() actually loaded (schema-a5, actions, b1, b2-tools,
-- backups, bastion-hitl, c1, consent, cw-10, cw-9, d5, files,
-- invite-dedup, marketplace(-s3), mcp-tokens, messages,
-- powers-mcp-hosted, qcx-publish-claims, qcx-visitors, quoxchat, reg,
-- retention, updates) + db/migrations/github-mappings.sql, PLUS every
-- inline ad-hoc `CREATE TABLE` block that previously lived only in
-- db/index.js's applyMigrations() (custom_roles, session_policies,
-- ip_allowlist, sso_providers/domains/sessions, sso_auth_states,
-- verified_domains, team_events/webhooks/webhook_deliveries,
-- scim_tokens, agent_role_permissions/tool_role_permissions,
-- llm_routing_policies, user_action_streaks, credential_folders,
-- agent_credential_assignments, credential_leases,
-- user_workflow_library, prompts/prompt_versions, tool_drafts,
-- widget_usage_monthly, widget_prompt_versions, pending_audit_events)
-- plus the static REG-CORE data_class_definitions seed rows — because
-- they are already part of the service's current live schema but were
-- never reflected into a .sql file.
--
-- Five schema-*.sql files under db/ (schema-multitenancy.sql,
-- schema-enterprise.sql, schema-lockout.sql, schema-desc-fix.sql,
-- schema-cw-fu.sql) are NOT included here — they are dead/historical
-- reference files never read by any code path (grepped zero references);
-- their content was independently re-implemented inline in
-- applyMigrations() and is folded in from there instead.
--
-- Column ADDs (bare ALTER TABLE ... ADD COLUMN) are deliberately NOT in
-- this file — SQLite has no "ADD COLUMN IF NOT EXISTS", and this whole
-- file runs as a single db.exec() call, so one non-idempotent statement
-- failing here would abort every statement after it. All ALTERs live in
-- their own numbered migration files (001+), isolated exactly the way
-- the original applyMigrations() gated/tried them.

-- ===== BEGIN schema.sql =====
-- Quox Auth Service Database Schema
-- Phase A: Auth + Security + Teams Foundation

-- ============================================================================
-- IDENTITY & AUTHENTICATION
-- ============================================================================

-- Global users table (person, not org-scoped)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                    -- ULID
    primary_email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    avatar_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending_verification',  -- pending_verification, active, suspended, deleted
    mfa_enabled INTEGER NOT NULL DEFAULT 0,
    mfa_secret TEXT,                        -- TOTP secret (encrypted)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,
    -- Added via migration (exist in running DB)
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    lockout_until TEXT,
    last_failed_at TEXT,
    metadata_json TEXT DEFAULT '{}',
    preferences_json TEXT DEFAULT '{}',       -- Cross-device user preferences (extensions, settings, etc.)
    timezone TEXT
);

-- Email addresses (multiple per user, one primary)
CREATE TABLE IF NOT EXISTS user_emails (
    id TEXT PRIMARY KEY,                    -- ULID
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    verified_at TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    verification_token TEXT,
    verification_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Authentication identities (password, OAuth providers)
CREATE TABLE IF NOT EXISTS auth_identities (
    id TEXT PRIMARY KEY,                    -- ULID
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,                 -- 'password', 'google', 'github', 'azure', 'okta'
    provider_sub TEXT,                      -- External provider user ID
    password_hash TEXT,                     -- Argon2id hash (for password provider only)
    metadata_json TEXT,                     -- Provider-specific metadata
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, provider)
);

-- Sessions (refresh token tracking)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,                    -- ULID (also serves as refresh token ID)
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id TEXT,                            -- Active org context (nullable)
    refresh_token_hash TEXT NOT NULL,       -- SHA256 of refresh token
    device_fingerprint TEXT,
    ip_address TEXT,
    user_agent TEXT,
    mfa_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT,
    last_active_at TEXT                     -- ET-ENFORCE E: driven by authenticate middleware for idle-timeout checks
);

-- MFA backup codes
CREATE TABLE IF NOT EXISTS mfa_backup_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,                -- SHA256 of code
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- ORGANIZATIONS & TEAMS
-- ============================================================================

-- Organizations (tenants)
CREATE TABLE IF NOT EXISTS orgs (
    id TEXT PRIMARY KEY,                    -- ULID
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,              -- URL-friendly identifier
    description TEXT,                       -- Organization description
    plan TEXT NOT NULL DEFAULT 'free',      -- free, starter, team, enterprise
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    logo_url TEXT,
    settings_json TEXT DEFAULT '{}',
    mfa_policy TEXT NOT NULL DEFAULT 'optional',  -- optional, required_admins, required_all
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

-- Org memberships (user's role in an org)
CREATE TABLE IF NOT EXISTS org_memberships (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'viewer',    -- owner, admin, builder, runner, viewer
    status TEXT NOT NULL DEFAULT 'active',  -- invited, active, suspended, removed, left
    invited_by TEXT REFERENCES users(id),
    invited_at TEXT,
    accepted_at TEXT,
    preferences_json TEXT DEFAULT '{}',     -- Per-org user preferences (cross-device, org-scoped)
    custom_role_id TEXT,                    -- ET-ENFORCE B: optional custom role overlay (unions caps)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, user_id)
);

-- Teams within orgs
CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    parent_team_id TEXT REFERENCES teams(id),  -- For team hierarchy
    settings_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, slug)
);

-- Team memberships
CREATE TABLE IF NOT EXISTS team_memberships (
    id TEXT PRIMARY KEY,                    -- ULID
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',    -- admin, member, viewer
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(team_id, user_id)
);

-- ============================================================================
-- INVITES
-- ============================================================================

CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    invited_by TEXT NOT NULL REFERENCES users(id),
    token TEXT NOT NULL UNIQUE,             -- Secure random token
    status TEXT NOT NULL DEFAULT 'pending', -- pending, accepted, expired, revoked
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    accepted_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- SERVICE ACCOUNTS (non-human identities)
-- ============================================================================

CREATE TABLE IF NOT EXISTS service_accounts (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    role TEXT NOT NULL DEFAULT 'runner',    -- Same roles as users
    api_key_hash TEXT NOT NULL,             -- SHA256 of API key (only stored hashed)
    api_key_prefix TEXT NOT NULL,           -- First 8 chars for identification
    last_used_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',  -- active, suspended, revoked
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
);

-- ============================================================================
-- SECRETS (encrypted storage)
-- ============================================================================

CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    scope_id TEXT,                          -- Team/project scope (nullable = org-wide)
    name TEXT NOT NULL,
    description TEXT,
    ciphertext TEXT NOT NULL,               -- Encrypted value
    metadata_json TEXT DEFAULT '{}',        -- Type hints, rotation info
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    rotated_at TEXT,
    UNIQUE(org_id, scope_id, name)
);

-- ============================================================================
-- INTEGRATION CREDENTIALS (API Keys, OAuth Tokens for External Services)
-- ============================================================================

CREATE TABLE IF NOT EXISTS integration_credentials (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    scope_id TEXT,                          -- Team/project scope (nullable = org-wide)

    -- Integration identification
    integration_type TEXT NOT NULL,         -- 'openai', 'gemini', 'elevenlabs', 'n8n', 'telegram', 'slack', 'custom'
    label TEXT NOT NULL,                    -- User-friendly name: "Production OpenAI", "Dev API Key"

    -- Encrypted credentials (AES-256-GCM)
    ciphertext TEXT NOT NULL,               -- Encrypted JSON: { api_key, api_secret, token, etc. }
    key_preview TEXT,                       -- Masked preview: "****xyz" (last 3 chars)

    -- Custom integration configuration
    endpoint_url TEXT,                      -- For custom integrations: base URL
    auth_type TEXT DEFAULT 'api_key',       -- 'api_key', 'bearer', 'basic', 'oauth2'
    headers_json TEXT DEFAULT '{}',         -- Additional headers (non-sensitive)

    -- Metadata
    description TEXT,
    metadata_json TEXT DEFAULT '{}',        -- Type-specific config: model, region, etc.
    is_default INTEGER NOT NULL DEFAULT 0,  -- Default credential for this type in org

    -- Audit fields
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    last_tested_at TEXT,
    test_status TEXT DEFAULT 'untested',    -- 'success', 'failed', 'untested'

    -- Rotation & expiration (Phase 4)
    rotated_at TEXT,                        -- Last rotation timestamp
    expires_at TEXT,                        -- Credential expiration (manual or provider-set)

    -- Constraints
    UNIQUE(org_id, scope_id, integration_type, label)
);

-- ============================================================================
-- AUDIT LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT REFERENCES orgs(id),        -- Nullable for pre-org events (signup)
    actor_type TEXT NOT NULL,               -- user, service_account, system
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,                   -- e.g., 'auth.login', 'org.member.invite', 'secret.access'
    target_type TEXT,                       -- user, org, team, secret, etc.
    target_id TEXT,
    scope_id TEXT,                          -- Team/project scope if applicable
    status TEXT NOT NULL DEFAULT 'success', -- success, failure, denied
    ip_address TEXT,
    user_agent TEXT,
    metadata_json TEXT DEFAULT '{}',        -- Action-specific details
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- RATE LIMITING
-- ============================================================================

CREATE TABLE IF NOT EXISTS rate_limits (
    id TEXT PRIMARY KEY,                    -- ULID
    key TEXT NOT NULL,                      -- IP, user_id, org_id, etc.
    endpoint TEXT NOT NULL,                 -- Route pattern
    window_start TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(key, endpoint, window_start)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Users
CREATE INDEX IF NOT EXISTS idx_users_email ON users(primary_email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- User emails
CREATE INDEX IF NOT EXISTS idx_user_emails_user_id ON user_emails(user_id);
CREATE INDEX IF NOT EXISTS idx_user_emails_email ON user_emails(email);
CREATE INDEX IF NOT EXISTS idx_user_emails_verification ON user_emails(verification_token);

-- Auth identities
CREATE INDEX IF NOT EXISTS idx_auth_identities_user_id ON auth_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_identities_provider ON auth_identities(provider, provider_sub);

-- Sessions
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Orgs
CREATE INDEX IF NOT EXISTS idx_orgs_slug ON orgs(slug);
CREATE INDEX IF NOT EXISTS idx_orgs_owner ON orgs(owner_user_id);

-- Org memberships
CREATE INDEX IF NOT EXISTS idx_org_memberships_org ON org_memberships(org_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_user ON org_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_status ON org_memberships(org_id, status);

-- Teams
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(org_id);
CREATE INDEX IF NOT EXISTS idx_teams_slug ON teams(org_id, slug);

-- Team memberships
CREATE INDEX IF NOT EXISTS idx_team_memberships_team ON team_memberships(team_id);
CREATE INDEX IF NOT EXISTS idx_team_memberships_user ON team_memberships(user_id);

-- Invites
CREATE INDEX IF NOT EXISTS idx_invites_org ON invites(org_id);
CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status);

-- Service accounts
CREATE INDEX IF NOT EXISTS idx_service_accounts_org ON service_accounts(org_id);
CREATE INDEX IF NOT EXISTS idx_service_accounts_key ON service_accounts(api_key_prefix);

-- Secrets
CREATE INDEX IF NOT EXISTS idx_secrets_org ON secrets(org_id);
CREATE INDEX IF NOT EXISTS idx_secrets_scope ON secrets(org_id, scope_id);

-- Integration credentials
CREATE INDEX IF NOT EXISTS idx_integration_credentials_org ON integration_credentials(org_id);
CREATE INDEX IF NOT EXISTS idx_integration_credentials_type ON integration_credentials(org_id, integration_type);
CREATE INDEX IF NOT EXISTS idx_integration_credentials_scope ON integration_credentials(org_id, scope_id);
CREATE INDEX IF NOT EXISTS idx_integration_credentials_default ON integration_credentials(org_id, integration_type, is_default);
CREATE INDEX IF NOT EXISTS idx_integration_credentials_label ON integration_credentials(org_id, integration_type, label);
CREATE INDEX IF NOT EXISTS idx_integration_credentials_expires ON integration_credentials(org_id, expires_at);

-- Audit events (critical for queries)
CREATE INDEX IF NOT EXISTS idx_audit_org_ts ON audit_events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_type, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_events(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action, created_at DESC);

-- Rate limits
CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON rate_limits(key, endpoint, window_start);

-- ===== END schema.sql =====

-- ===== BEGIN schema-a5.sql =====
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
INSERT OR IGNORE INTO services (id, name, display_name, description, health_endpoint, expected_port) VALUES
    ('auth', 'auth', 'Auth Service', 'Authentication and authorization', 'http://localhost:3101/health', 3101),
    ('n8n', 'n8n', 'n8n Workflows', 'Workflow automation engine (optional — with-n8n compose profile)', 'http://n8n:5678/healthz', 5678),
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

-- ===== END schema-a5.sql =====

-- ===== BEGIN schema-actions.sql =====
-- Action Items schema (Scoped Storage Architecture)
-- Org-scoped action tracker with role-based visibility

CREATE TABLE IF NOT EXISTS action_items (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    scope_id TEXT REFERENCES scopes(id),       -- NULL = org-wide
    created_by TEXT NOT NULL REFERENCES users(id),
    assigned_to TEXT REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
    category TEXT DEFAULT '',
    status TEXT DEFAULT 'todo' CHECK(status IN ('todo','doing','done')),
    due_date TEXT,                              -- ISO date string
    source TEXT DEFAULT 'user' CHECK(source IN ('user','ai','workflow')),
    source_agent TEXT,                          -- e.g. 'quox' if AI-created
    notes TEXT DEFAULT '',
    "order" INTEGER DEFAULT 0,
    tags TEXT DEFAULT '[]',                     -- JSON array
    archived_at TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT                             -- Soft delete
);

CREATE INDEX IF NOT EXISTS idx_action_items_org ON action_items(org_id);
CREATE INDEX IF NOT EXISTS idx_action_items_scope ON action_items(org_id, scope_id);
CREATE INDEX IF NOT EXISTS idx_action_items_created_by ON action_items(org_id, created_by);
CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(org_id, status);
CREATE INDEX IF NOT EXISTS idx_action_items_assigned ON action_items(org_id, assigned_to);

-- Per-(user, org) completion streak. Bumped server-side when an action item
-- transitions to status='done'. Persists across browser/device — replaces the
-- old localStorage-only streak.
CREATE TABLE IF NOT EXISTS user_action_streaks (
    user_id TEXT NOT NULL REFERENCES users(id),
    org_id TEXT NOT NULL REFERENCES orgs(id),
    current_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    last_completion_date TEXT,                 -- ISO date YYYY-MM-DD (UTC)
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, org_id)
);

-- ===== END schema-actions.sql =====

-- ===== BEGIN schema-b1.sql =====
-- Quox Auth Service Database Schema
-- Phase B.1: Organization Model + Directory
-- ============================================================================

-- ============================================================================
-- ORGANIZATIONAL HIERARCHY
-- ============================================================================

-- Divisions (top-level org units)
CREATE TABLE IF NOT EXISTS divisions (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    profile_json TEXT DEFAULT '{}',         -- Custom fields, metadata
    sort_order INTEGER DEFAULT 0,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,
    UNIQUE(org_id, slug)
);

-- Departments (within divisions)
CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    division_id TEXT NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    profile_json TEXT DEFAULT '{}',
    sort_order INTEGER DEFAULT 0,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,
    UNIQUE(division_id, slug)
);

-- ============================================================================
-- UNIFIED SCOPE SYSTEM
-- ============================================================================

-- Scopes table - unified hierarchy reference
-- Path format: /org/{orgId}/div/{divId}/dept/{deptId}/team/{teamId}
CREATE TABLE IF NOT EXISTS scopes (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL,               -- 'org', 'division', 'department', 'team'
    ref_id TEXT NOT NULL,                   -- Points to actual entity ID
    parent_scope_id TEXT REFERENCES scopes(id),
    path TEXT NOT NULL,                     -- Materialized path for fast queries
    name_cache TEXT NOT NULL,               -- Cached name for display
    depth INTEGER NOT NULL DEFAULT 0,       -- 0=org, 1=division, 2=department, 3=team
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, scope_type, ref_id)
);

-- Scope policies - inherited config down the tree
CREATE TABLE IF NOT EXISTS scope_policies (
    id TEXT PRIMARY KEY,                    -- ULID
    scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
    policy_json TEXT NOT NULL DEFAULT '{}', -- Permissions, defaults, restrictions
    inherit_parent INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(scope_id)
);

-- ============================================================================
-- SHARE POLICIES
-- ============================================================================

-- Share policies define visibility rules for assets
CREATE TABLE IF NOT EXISTS share_policies (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    mode TEXT NOT NULL,                     -- 'private', 'team', 'department', 'division', 'org', 'explicit'
    rules_json TEXT DEFAULT '{}',           -- Additional rules (explicit user/team lists, conditions)
    is_system INTEGER NOT NULL DEFAULT 0,   -- System policies cannot be deleted
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, name)
);

-- Default system policies (created by migration)
-- 1. Private - only creator
-- 2. Team Only - team members
-- 3. Department - department members
-- 4. Division - division members
-- 5. Org-Wide - all org members

-- ============================================================================
-- ASSET REGISTRY - TOOLS (Priority 1)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    home_scope_id TEXT REFERENCES scopes(id),  -- Where tool "lives"
    share_policy_id TEXT REFERENCES share_policies(id),

    -- Identity
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    icon TEXT,                              -- Emoji or icon identifier

    -- Tool specification
    tool_type TEXT NOT NULL,                -- 'mcp', 'function', 'api', 'script', 'workflow'
    spec_json TEXT NOT NULL DEFAULT '{}',   -- Tool-type specific config
    -- For MCP: { server: "...", tool: "...", config: {} }
    -- For function: { module: "...", function: "...", params_schema: {} }
    -- For API: { url: "...", method: "...", headers: {}, body_template: "" }
    -- For script: { language: "...", code: "...", timeout: 30 }
    -- For workflow: { workflow_id: "...", input_mapping: {} }

    -- Metadata
    input_schema_json TEXT DEFAULT '{}',    -- JSON Schema for inputs
    output_schema_json TEXT DEFAULT '{}',   -- JSON Schema for outputs
    examples_json TEXT DEFAULT '[]',        -- Usage examples

    -- Risk & access
    risk_level TEXT NOT NULL DEFAULT 'low', -- 'low', 'medium', 'high', 'critical'
    requires_approval INTEGER NOT NULL DEFAULT 0,

    -- Tags stored separately via asset_tags

    -- Status
    status TEXT NOT NULL DEFAULT 'active',  -- 'draft', 'active', 'deprecated', 'archived'
    version INTEGER NOT NULL DEFAULT 1,

    -- Audit
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    published_at TEXT,
    deprecated_at TEXT,

    UNIQUE(org_id, slug)
);

-- Tool versions (history)
CREATE TABLE IF NOT EXISTS tool_versions (
    id TEXT PRIMARY KEY,                    -- ULID
    tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    spec_json TEXT NOT NULL,
    input_schema_json TEXT,
    output_schema_json TEXT,
    change_summary TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tool_id, version)
);

-- ============================================================================
-- ASSET REGISTRY - WORKFLOWS (Priority 2)
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    home_scope_id TEXT REFERENCES scopes(id),
    share_policy_id TEXT REFERENCES share_policies(id),

    -- Identity
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    notes TEXT,
    icon TEXT,

    -- Definition
    definition_json TEXT NOT NULL DEFAULT '{}',  -- Full workflow graph
    -- Structure: { nodes: [], edges: [], config: {} }

    -- Trigger configuration
    trigger_type TEXT,                      -- 'manual', 'schedule', 'event', 'webhook'
    trigger_config_json TEXT DEFAULT '{}',

    -- Execution settings
    timeout_seconds INTEGER DEFAULT 300,
    max_retries INTEGER DEFAULT 0,

    -- Status
    status TEXT NOT NULL DEFAULT 'draft',   -- 'draft', 'active', 'paused', 'archived'
    version INTEGER NOT NULL DEFAULT 1,

    -- Audit
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    published_at TEXT,

    UNIQUE(org_id, slug)
);

-- Workflow steps (individual nodes)
CREATE TABLE IF NOT EXISTS workflow_steps (
    id TEXT PRIMARY KEY,                    -- ULID
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,                   -- Step order

    -- Step definition
    step_type TEXT NOT NULL,                -- 'tool', 'assistant', 'condition', 'loop', 'parallel', 'wait'
    ref_id TEXT,                            -- References tool_id, assistant_id, etc.
    label TEXT,

    -- Configuration
    config_json TEXT DEFAULT '{}',          -- Step-specific config
    input_mapping_json TEXT DEFAULT '{}',   -- Map from previous steps
    output_mapping_json TEXT DEFAULT '{}',  -- Transform outputs

    -- Conditions
    condition_json TEXT,                    -- For conditional steps

    -- Position (for visual editor)
    position_x INTEGER DEFAULT 0,
    position_y INTEGER DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Workflow versions
CREATE TABLE IF NOT EXISTS workflow_versions (
    id TEXT PRIMARY KEY,                    -- ULID
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    definition_json TEXT NOT NULL,
    change_summary TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workflow_id, version)
);

-- ============================================================================
-- USER WORKFLOW LIBRARY (STUDY-REV-2 / P5.D)
-- Per-org/per-user saved workflow entries ("My Library")
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_workflow_library (
    id TEXT PRIMARY KEY,                        -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    definition_json TEXT NOT NULL,              -- Full workflow definition (JSON)
    source TEXT NOT NULL DEFAULT 'mine',        -- 'curated' | 'n8n-imported' | 'mine'
    source_workflow_id TEXT,                    -- Original library ID if saved from a template
    tags TEXT DEFAULT '[]',                     -- JSON array of strings
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, user_id, name)               -- No duplicate names per user/org
);

CREATE INDEX IF NOT EXISTS idx_uwl_org_user
    ON user_workflow_library (org_id, user_id);

-- ============================================================================
-- ASSET REGISTRY - ASSISTANTS (Priority 3)
-- ============================================================================

CREATE TABLE IF NOT EXISTS assistants (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    home_scope_id TEXT REFERENCES scopes(id),
    share_policy_id TEXT REFERENCES share_policies(id),

    -- Identity
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    avatar_url TEXT,
    icon TEXT,

    -- Persona definition
    persona_json TEXT NOT NULL DEFAULT '{}',
    -- Structure: {
    --   system_prompt: "...",
    --   personality: { tone: "...", style: "..." },
    --   instructions: [...],
    --   examples: [...]
    -- }

    -- Model configuration
    model_id TEXT DEFAULT 'claude-sonnet-4-20250514',
    model_config_json TEXT DEFAULT '{}',    -- temperature, max_tokens, etc.

    -- Tools & capabilities
    allowed_tools_json TEXT DEFAULT '[]',   -- List of tool IDs this assistant can use
    allowed_workflows_json TEXT DEFAULT '[]',

    -- Memory & context
    memory_enabled INTEGER NOT NULL DEFAULT 1,
    context_window INTEGER DEFAULT 200000,

    -- Template & deployment
    is_template INTEGER NOT NULL DEFAULT 0,
    template_source_id TEXT REFERENCES assistants(id),

    -- Status
    status TEXT NOT NULL DEFAULT 'draft',   -- 'draft', 'active', 'deprecated', 'archived'
    version INTEGER NOT NULL DEFAULT 1,

    -- Audit
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    published_at TEXT,

    UNIQUE(org_id, slug)
);

-- Assistant deployments (where assistants are available)
CREATE TABLE IF NOT EXISTS assistant_deployments (
    id TEXT PRIMARY KEY,                    -- ULID
    assistant_id TEXT NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,

    -- Deployment config
    mode TEXT NOT NULL DEFAULT 'available', -- 'available', 'default', 'exclusive'
    config_override_json TEXT DEFAULT '{}', -- Scope-specific overrides

    -- Status
    status TEXT NOT NULL DEFAULT 'active',  -- 'active', 'paused', 'retired'

    -- Audit
    deployed_by TEXT REFERENCES users(id),
    deployed_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(assistant_id, scope_id)
);

-- Assistant versions
CREATE TABLE IF NOT EXISTS assistant_versions (
    id TEXT PRIMARY KEY,                    -- ULID
    assistant_id TEXT NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    persona_json TEXT NOT NULL,
    model_config_json TEXT,
    allowed_tools_json TEXT,
    change_summary TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(assistant_id, version)
);

-- ============================================================================
-- TAGGING SYSTEM
-- ============================================================================

CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    color TEXT DEFAULT '#666666',           -- Hex color for display
    icon TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, slug)
);

-- Asset-tag relationships (polymorphic)
CREATE TABLE IF NOT EXISTS asset_tags (
    id TEXT PRIMARY KEY,                    -- ULID
    asset_type TEXT NOT NULL,               -- 'tool', 'workflow', 'assistant'
    asset_id TEXT NOT NULL,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(asset_type, asset_id, tag_id)
);

-- ============================================================================
-- FAVORITES & RECENT
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_favorites (
    id TEXT PRIMARY KEY,                    -- ULID
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    asset_type TEXT NOT NULL,               -- 'tool', 'workflow', 'assistant'
    asset_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, asset_type, asset_id)
);

CREATE TABLE IF NOT EXISTS user_recent (
    id TEXT PRIMARY KEY,                    -- ULID
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    asset_type TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(user_id, asset_type, asset_id)
);

-- ============================================================================
-- DIRECTORY SEARCH
-- ============================================================================

-- Materialized view-like table for fast directory search
CREATE TABLE IF NOT EXISTS directory_index (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    asset_type TEXT NOT NULL,               -- 'tool', 'workflow', 'assistant'
    asset_id TEXT NOT NULL,

    -- Searchable fields
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,

    -- Display
    icon TEXT,
    status TEXT,

    -- Scope info
    home_scope_id TEXT,
    home_scope_path TEXT,

    -- Visibility
    share_mode TEXT,

    -- Metadata
    tags_cache TEXT,                        -- Comma-separated tag names
    created_by TEXT,
    created_at TEXT,
    updated_at TEXT,

    -- For full-text search
    search_text TEXT,                       -- Concatenated searchable content

    UNIQUE(asset_type, asset_id)
);

-- ============================================================================
-- SCHEMA MODIFICATIONS
-- ============================================================================

-- Add attach_scope_id to teams (links team to scope tree)
-- NOTE: Run this as ALTER TABLE in migration, not here
-- ALTER TABLE teams ADD COLUMN attach_scope_id TEXT REFERENCES scopes(id);

-- Add notes column to workflows (longer-form explanation of what a workflow does)
-- Safe to re-run: SQLite ignores duplicate ADD COLUMN if column already exists via CREATE TABLE
-- ALTER TABLE workflows ADD COLUMN notes TEXT;

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Divisions
CREATE INDEX IF NOT EXISTS idx_divisions_org ON divisions(org_id);
CREATE INDEX IF NOT EXISTS idx_divisions_slug ON divisions(org_id, slug);

-- Departments
CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(org_id);
CREATE INDEX IF NOT EXISTS idx_departments_division ON departments(division_id);
CREATE INDEX IF NOT EXISTS idx_departments_slug ON departments(division_id, slug);

-- Scopes
CREATE INDEX IF NOT EXISTS idx_scopes_org ON scopes(org_id);
CREATE INDEX IF NOT EXISTS idx_scopes_type ON scopes(org_id, scope_type);
CREATE INDEX IF NOT EXISTS idx_scopes_parent ON scopes(parent_scope_id);
CREATE INDEX IF NOT EXISTS idx_scopes_path ON scopes(path);
CREATE INDEX IF NOT EXISTS idx_scopes_ref ON scopes(scope_type, ref_id);

-- Share policies
CREATE INDEX IF NOT EXISTS idx_share_policies_org ON share_policies(org_id);
CREATE INDEX IF NOT EXISTS idx_share_policies_mode ON share_policies(org_id, mode);

-- Tools
CREATE INDEX IF NOT EXISTS idx_tools_org ON tools(org_id);
CREATE INDEX IF NOT EXISTS idx_tools_slug ON tools(org_id, slug);
CREATE INDEX IF NOT EXISTS idx_tools_scope ON tools(home_scope_id);
CREATE INDEX IF NOT EXISTS idx_tools_type ON tools(org_id, tool_type);
CREATE INDEX IF NOT EXISTS idx_tools_status ON tools(org_id, status);
CREATE INDEX IF NOT EXISTS idx_tools_share ON tools(share_policy_id);

-- Workflows
CREATE INDEX IF NOT EXISTS idx_workflows_org ON workflows(org_id);
CREATE INDEX IF NOT EXISTS idx_workflows_slug ON workflows(org_id, slug);
CREATE INDEX IF NOT EXISTS idx_workflows_scope ON workflows(home_scope_id);
CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(org_id, status);

-- Workflow steps
CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow ON workflow_steps(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_order ON workflow_steps(workflow_id, idx);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_ref ON workflow_steps(step_type, ref_id);

-- Assistants
CREATE INDEX IF NOT EXISTS idx_assistants_org ON assistants(org_id);
CREATE INDEX IF NOT EXISTS idx_assistants_slug ON assistants(org_id, slug);
CREATE INDEX IF NOT EXISTS idx_assistants_scope ON assistants(home_scope_id);
CREATE INDEX IF NOT EXISTS idx_assistants_status ON assistants(org_id, status);
CREATE INDEX IF NOT EXISTS idx_assistants_template ON assistants(org_id, is_template);

-- Assistant deployments
CREATE INDEX IF NOT EXISTS idx_assistant_deployments_assistant ON assistant_deployments(assistant_id);
CREATE INDEX IF NOT EXISTS idx_assistant_deployments_scope ON assistant_deployments(scope_id);
CREATE INDEX IF NOT EXISTS idx_assistant_deployments_status ON assistant_deployments(status);

-- Tags
CREATE INDEX IF NOT EXISTS idx_tags_org ON tags(org_id);
CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(org_id, slug);

-- Asset tags
CREATE INDEX IF NOT EXISTS idx_asset_tags_asset ON asset_tags(asset_type, asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag_id);

-- User favorites
CREATE INDEX IF NOT EXISTS idx_user_favorites_user ON user_favorites(user_id, org_id);
CREATE INDEX IF NOT EXISTS idx_user_favorites_asset ON user_favorites(asset_type, asset_id);

-- User recent
CREATE INDEX IF NOT EXISTS idx_user_recent_user ON user_recent(user_id, org_id);
CREATE INDEX IF NOT EXISTS idx_user_recent_time ON user_recent(user_id, last_accessed_at DESC);

-- Directory index
CREATE INDEX IF NOT EXISTS idx_directory_org ON directory_index(org_id);
CREATE INDEX IF NOT EXISTS idx_directory_type ON directory_index(org_id, asset_type);
CREATE INDEX IF NOT EXISTS idx_directory_scope ON directory_index(home_scope_id);
CREATE INDEX IF NOT EXISTS idx_directory_status ON directory_index(org_id, status);
CREATE INDEX IF NOT EXISTS idx_directory_search ON directory_index(org_id, search_text);

-- ===== END schema-b1.sql =====

-- ===== BEGIN schema-b2-tools.sql =====
-- Quox Auth Service Database Schema
-- Phase B.2: Tool Library & Catalog (Agent-Centric Model)
-- ============================================================================
--
-- ARCHITECTURE: Tools are assigned to AGENTS, not users/orgs directly
-- - Assistants discover and delegate to specialized agents
-- - Each agent has a narrow, focused toolset
-- - No agent should have access to ALL tools
--
-- This schema adds:
-- - tool_definitions: Global catalog of available tools
-- - tool_installations: Makes tools AVAILABLE in an org (with config)
-- - agents: Org-specific agents that can use tools
-- - agent_tool_assignments: Which tools each agent can access (CRITICAL)
-- - agent_tool_context: Pre-computed context for prompt injection
-- - assistant_agent_routing: How assistants delegate to agents
-- - tool_executions: Sandbox execution audit log
--
-- Flow: User → Assistant → Agent (has tools) → Tool Execution
-- ============================================================================

-- ============================================================================
-- TOOL DEFINITIONS (Global Catalog)
-- ============================================================================

-- Master catalog of all available tools
-- These are system-wide, not org-specific
CREATE TABLE IF NOT EXISTS tool_definitions (
    id TEXT PRIMARY KEY,                    -- ULID
    tool_id TEXT UNIQUE NOT NULL,           -- Canonical ID: 'monitoring.prometheus.query'

    -- Identity
    name TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,                 -- Primary category for filtering
    subcategory TEXT,                       -- Optional subcategory
    provider TEXT,                          -- External provider: 'prometheus', 'github', etc.
    version TEXT NOT NULL DEFAULT '1.0.0',  -- Semver

    -- Full manifest (ToolCard v2 JSON)
    spec_json TEXT NOT NULL,                -- Complete tool manifest with instructions, help, hints

    -- Discovery fields (denormalized for fast queries)
    risk_level TEXT NOT NULL DEFAULT 'low'
        CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
    sandbox_profile TEXT NOT NULL DEFAULT 'standard'
        CHECK (sandbox_profile IN ('restricted', 'standard', 'privileged')),
    capabilities_json TEXT DEFAULT '[]',    -- ["read", "write", "network", "filesystem", "execute"]

    -- Access & requirements
    min_access_level TEXT NOT NULL DEFAULT 'specialists+'
        CHECK (min_access_level IN ('orchestrator', 'managers+', 'specialists+', 'workers+', 'all')),
    requires_license TEXT,                  -- License tier required (null = free)
    requires_config INTEGER NOT NULL DEFAULT 0,  -- Requires org-specific config (endpoints, keys)

    -- Lifecycle
    status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'beta', 'deprecated', 'disabled', 'coming_soon')),
    is_core INTEGER NOT NULL DEFAULT 0,     -- Core tools bundled with system
    is_featured INTEGER NOT NULL DEFAULT 0, -- Featured in catalog

    -- Metadata
    icon TEXT,                              -- Icon identifier or emoji
    documentation_url TEXT,                 -- Link to docs
    source_url TEXT,                        -- Link to source repo

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    published_at TEXT,
    deprecated_at TEXT
);

-- Tool definition versions (for updates)
CREATE TABLE IF NOT EXISTS tool_definition_versions (
    id TEXT PRIMARY KEY,                    -- ULID
    tool_definition_id TEXT NOT NULL REFERENCES tool_definitions(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    changelog TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tool_definition_id, version)
);

-- ============================================================================
-- TOOL INSTALLATIONS (Per-Org - Makes Tool AVAILABLE)
-- ============================================================================

-- Org-level tool availability and configuration
-- This makes a tool AVAILABLE in the org, but does NOT grant access
-- Access is ALWAYS through agent_tool_assignments
CREATE TABLE IF NOT EXISTS tool_installations (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    tool_definition_id TEXT NOT NULL REFERENCES tool_definitions(id) ON DELETE CASCADE,

    -- Configuration (org-specific overrides)
    config_json TEXT DEFAULT '{}',          -- Endpoint URLs, API keys reference, custom params
    -- Example: { "endpoint": "http://my-prometheus:9090", "api_key_ref": "secret:prom_key" }

    -- State
    enabled INTEGER NOT NULL DEFAULT 1,
    pinned_version TEXT,                    -- Pin to specific version (null = latest)

    -- Audit
    installed_by TEXT REFERENCES users(id),
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    disabled_at TEXT,
    disabled_by TEXT REFERENCES users(id),

    UNIQUE(org_id, tool_definition_id)
);

-- ============================================================================
-- AGENT TOOL ASSIGNMENTS (Agent-Centric Access)
-- ============================================================================

-- CRITICAL: Tools are assigned to AGENTS, not orgs or users directly
-- Even top-level assistants must delegate to agents with specific tool access
-- No agent should have access to ALL tools - narrow, focused toolsets
--
-- BEST PRACTICE LIMITS (enforced in API, warnings in UI):
--   - WARN at 5+ tools: "Consider splitting into multiple specialized agents"
--   - WARN at 8+ tools: "This agent has many tools. Context bloat may reduce effectiveness"
--   - HARD LIMIT at 15 tools: Requires admin override to exceed
--
-- Why? Narrow agents are:
--   - Easier for assistants to route to (clear purpose)
--   - More efficient (smaller context = faster, cheaper)
--   - More reliable (less confusion about which tool to use)
--   - Easier to audit and secure
--
CREATE TABLE IF NOT EXISTS agent_tool_assignments (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    tool_installation_id TEXT NOT NULL REFERENCES tool_installations(id) ON DELETE CASCADE,

    -- The agent receiving access
    agent_id TEXT NOT NULL,                 -- Agent manifest ID (e.g., 'sentinel', 'cipher')

    -- Scope restriction (optional - further limits where agent can use this tool)
    scope_id TEXT REFERENCES scopes(id),    -- null = anywhere in org agent operates

    -- Assignment details
    access_mode TEXT NOT NULL DEFAULT 'full'
        CHECK (access_mode IN ('full', 'read_only', 'with_approval')),
    -- full: Agent can use tool without restrictions
    -- read_only: Agent can only use read operations (if tool supports)
    -- with_approval: Every use requires human approval

    -- Constraints
    max_daily_invocations INTEGER,          -- Rate limit (null = unlimited)
    allowed_operations_json TEXT,           -- Subset of tool operations (null = all)
    -- Example: ["prometheus.query", "prometheus.alerts"] but not "prometheus.targets"

    -- State
    enabled INTEGER NOT NULL DEFAULT 1,

    -- Audit
    assigned_by TEXT REFERENCES users(id),
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT,
    revoked_by TEXT REFERENCES users(id),

    UNIQUE(org_id, tool_installation_id, agent_id)
);

-- ============================================================================
-- AGENT DEFINITIONS (Org-Specific Agents)
-- ============================================================================

-- Agents are the ONLY entities that can access tools
-- Assistants discover and delegate to agents
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- Identity
    agent_id TEXT NOT NULL,                 -- Manifest ID (e.g., 'prometheus_agent', 'docker_agent')
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,

    -- Hierarchy
    level INTEGER NOT NULL DEFAULT 3,       -- 0=orchestrator, 1=manager, 2=specialist, 3=worker, 4=observer
    parent_agent_id TEXT REFERENCES agents(id),  -- Reports to
    manager_assistant_id TEXT,              -- Which assistant manages this agent

    -- Scope
    home_scope_id TEXT REFERENCES scopes(id),  -- Where agent operates (null = org-wide)

    -- Configuration
    config_json TEXT DEFAULT '{}',          -- Agent-specific config
    system_prompt_additions TEXT,           -- Additional system prompt context

    -- Domains (for routing)
    domains_json TEXT DEFAULT '[]',         -- ["monitoring", "infrastructure"]
    capabilities_json TEXT DEFAULT '[]',    -- ["query_metrics", "check_health"]

    -- State
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('draft', 'active', 'paused', 'retired')),
    retired_at TEXT,                        -- When agent was retired
    retired_by TEXT REFERENCES users(id),   -- Who retired the agent

    -- Audit
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(org_id, agent_id)
);

-- ============================================================================
-- TOOL MANAGEMENT PERMISSIONS (Who Can Configure Tools)
-- ============================================================================

-- Grants for who can MANAGE tools (install, configure, assign)
-- NOT for who can USE tools - that's always through agents
CREATE TABLE IF NOT EXISTS tool_admin_grants (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- Grant target (exactly one must be set)
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
    scope_id TEXT REFERENCES scopes(id) ON DELETE CASCADE,

    -- What they can manage
    permission TEXT NOT NULL
        CHECK (permission IN ('install', 'configure', 'assign', 'admin')),
    -- install: Can install/uninstall tools from catalog
    -- configure: Can modify tool configuration
    -- assign: Can assign tools to agents
    -- admin: All of the above + can grant permissions to others

    -- Scope of permission
    tool_installation_id TEXT REFERENCES tool_installations(id),  -- null = all tools in org

    -- Audit
    granted_by TEXT REFERENCES users(id),
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT,
    revoked_by TEXT REFERENCES users(id)
);

-- ============================================================================
-- TOOL EXECUTIONS (Sandbox Audit Log)
-- ============================================================================

-- Audit log for tool executions in sandboxed containers
CREATE TABLE IF NOT EXISTS tool_executions (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL,                   -- Denormalized for fast queries
    tool_installation_id TEXT NOT NULL REFERENCES tool_installations(id),

    -- Correlation
    invocation_id TEXT NOT NULL,            -- AEE envelope correlation ID
    conversation_id TEXT,                   -- Chat conversation ID

    -- Who invoked
    user_id TEXT REFERENCES users(id),
    agent_id TEXT,                          -- Agent manifest ID
    session_id TEXT,

    -- What was invoked
    tool_id TEXT NOT NULL,                  -- Canonical tool ID (e.g., 'prometheus.query')
    tool_name TEXT,                         -- Human-readable name

    -- Container details
    container_id TEXT,
    sandbox_profile TEXT NOT NULL,          -- restricted, standard, privileged
    image_tag TEXT,

    -- Execution result
    status TEXT NOT NULL
        CHECK (status IN ('pending', 'running', 'success', 'error', 'timeout', 'killed', 'pending_approval', 'rejected')),
    exit_code INTEGER,
    error_type TEXT,                        -- bad_data, timeout, execution, etc.
    error_message TEXT,

    -- Timing
    queued_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,

    -- Resource usage
    memory_peak_bytes INTEGER,
    cpu_time_ms INTEGER,
    network_bytes_in INTEGER,
    network_bytes_out INTEGER,

    -- Audit trail
    params_hash TEXT,                       -- SHA256 of params (privacy - don't store actual params)
    output_size_bytes INTEGER,
    output_truncated INTEGER DEFAULT 0,

    -- Approval (for privileged tools)
    approval_required INTEGER DEFAULT 0,
    approval_id TEXT,                       -- References inbox_items(id)
    approved_by TEXT REFERENCES users(id),
    approved_at TEXT
);

-- ============================================================================
-- TOOL USAGE STATISTICS (Aggregated)
-- ============================================================================

-- Daily aggregated usage stats per tool per org
CREATE TABLE IF NOT EXISTS tool_usage_daily (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    tool_installation_id TEXT NOT NULL REFERENCES tool_installations(id) ON DELETE CASCADE,
    date TEXT NOT NULL,                     -- YYYY-MM-DD

    -- Counts
    total_invocations INTEGER NOT NULL DEFAULT 0,
    successful_invocations INTEGER NOT NULL DEFAULT 0,
    failed_invocations INTEGER NOT NULL DEFAULT 0,
    timeout_invocations INTEGER NOT NULL DEFAULT 0,

    -- Unique users/agents
    unique_users INTEGER NOT NULL DEFAULT 0,
    unique_agents INTEGER NOT NULL DEFAULT 0,

    -- Performance
    total_duration_ms INTEGER NOT NULL DEFAULT 0,
    avg_duration_ms INTEGER,
    p50_duration_ms INTEGER,
    p95_duration_ms INTEGER,
    max_duration_ms INTEGER,

    -- Resources
    total_memory_bytes INTEGER,
    total_cpu_ms INTEGER,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(org_id, tool_installation_id, date)
);

-- ============================================================================
-- AGENT TOOL CONTEXT (Pre-computed for Injection)
-- ============================================================================

-- Materialized context for what tools an agent can use
-- Regenerated when assignments change
-- Used for fast context injection into agent prompts
CREATE TABLE IF NOT EXISTS agent_tool_context (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    agent_db_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

    -- Cached agent info
    agent_id TEXT NOT NULL,                 -- Manifest ID for fast lookup
    agent_name TEXT,

    -- Pre-computed context
    tools_count INTEGER NOT NULL DEFAULT 0,
    context_tokens INTEGER NOT NULL DEFAULT 0,  -- Estimated token count

    -- The actual context blob (for direct injection)
    tools_summary_json TEXT NOT NULL,       -- Compact tool list for prompt
    -- Structure: [{ id, name, summary, when_to_use[], risk }]

    full_instructions_json TEXT,            -- Full instructions (loaded on-demand)

    -- When computed
    computed_at TEXT NOT NULL DEFAULT (datetime('now')),
    stale INTEGER NOT NULL DEFAULT 0,       -- Mark stale when assignments change

    UNIQUE(org_id, agent_db_id)
);

-- ============================================================================
-- ASSISTANT-AGENT ROUTING (Which Agents Can Assistants Delegate To)
-- ============================================================================

-- Assistants don't have tools - they delegate to agents
-- This defines which agents an assistant can route tasks to
CREATE TABLE IF NOT EXISTS assistant_agent_routing (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- The assistant doing the routing
    assistant_id TEXT NOT NULL,             -- Assistant manifest ID (e.g., 'quox', 'sentinel')

    -- The agent being routed to
    agent_db_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

    -- Routing priority (lower = preferred)
    priority INTEGER NOT NULL DEFAULT 100,

    -- Routing hints
    route_for_domains_json TEXT,            -- Domains this agent handles for this assistant
    route_for_intents_json TEXT,            -- Intents this agent handles

    -- State
    enabled INTEGER NOT NULL DEFAULT 1,

    -- Audit
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(org_id, assistant_id, agent_db_id)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Tool definitions
CREATE INDEX IF NOT EXISTS idx_tool_defs_tool_id ON tool_definitions(tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_defs_category ON tool_definitions(category);
CREATE INDEX IF NOT EXISTS idx_tool_defs_subcategory ON tool_definitions(category, subcategory);
CREATE INDEX IF NOT EXISTS idx_tool_defs_provider ON tool_definitions(provider);
CREATE INDEX IF NOT EXISTS idx_tool_defs_status ON tool_definitions(status);
CREATE INDEX IF NOT EXISTS idx_tool_defs_risk ON tool_definitions(risk_level);
CREATE INDEX IF NOT EXISTS idx_tool_defs_sandbox ON tool_definitions(sandbox_profile);
CREATE INDEX IF NOT EXISTS idx_tool_defs_featured ON tool_definitions(is_featured, status);
CREATE INDEX IF NOT EXISTS idx_tool_defs_core ON tool_definitions(is_core);

-- Tool installations
CREATE INDEX IF NOT EXISTS idx_tool_installs_org ON tool_installations(org_id);
CREATE INDEX IF NOT EXISTS idx_tool_installs_def ON tool_installations(tool_definition_id);
CREATE INDEX IF NOT EXISTS idx_tool_installs_enabled ON tool_installations(org_id, enabled);

-- Agent tool assignments (CRITICAL - main access table)
CREATE INDEX IF NOT EXISTS idx_agent_assign_org ON agent_tool_assignments(org_id);
CREATE INDEX IF NOT EXISTS idx_agent_assign_install ON agent_tool_assignments(tool_installation_id);
CREATE INDEX IF NOT EXISTS idx_agent_assign_agent ON agent_tool_assignments(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_assign_scope ON agent_tool_assignments(scope_id);
CREATE INDEX IF NOT EXISTS idx_agent_assign_lookup ON agent_tool_assignments(org_id, agent_id, enabled);
CREATE INDEX IF NOT EXISTS idx_agent_assign_active ON agent_tool_assignments(tool_installation_id, revoked_at);

-- Agents
CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org_id);
CREATE INDEX IF NOT EXISTS idx_agents_agent_id ON agents(org_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_level ON agents(org_id, level);
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_manager ON agents(manager_assistant_id);
CREATE INDEX IF NOT EXISTS idx_agents_scope ON agents(home_scope_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(org_id, status);

-- Tool admin grants
CREATE INDEX IF NOT EXISTS idx_tool_admin_org ON tool_admin_grants(org_id);
CREATE INDEX IF NOT EXISTS idx_tool_admin_user ON tool_admin_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_tool_admin_team ON tool_admin_grants(team_id);
CREATE INDEX IF NOT EXISTS idx_tool_admin_scope ON tool_admin_grants(scope_id);
CREATE INDEX IF NOT EXISTS idx_tool_admin_tool ON tool_admin_grants(tool_installation_id);

-- Tool executions
CREATE INDEX IF NOT EXISTS idx_tool_exec_org ON tool_executions(org_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_install ON tool_executions(tool_installation_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_invocation ON tool_executions(invocation_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_user ON tool_executions(user_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_agent ON tool_executions(agent_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_status ON tool_executions(status);
CREATE INDEX IF NOT EXISTS idx_tool_exec_time ON tool_executions(org_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_exec_tool ON tool_executions(tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_approval ON tool_executions(approval_id);

-- Tool usage daily
CREATE INDEX IF NOT EXISTS idx_tool_usage_org ON tool_usage_daily(org_id);
CREATE INDEX IF NOT EXISTS idx_tool_usage_install ON tool_usage_daily(tool_installation_id);
CREATE INDEX IF NOT EXISTS idx_tool_usage_date ON tool_usage_daily(date DESC);
CREATE INDEX IF NOT EXISTS idx_tool_usage_lookup ON tool_usage_daily(org_id, tool_installation_id, date);

-- Agent tool context (materialized)
CREATE INDEX IF NOT EXISTS idx_agent_context_org ON agent_tool_context(org_id);
CREATE INDEX IF NOT EXISTS idx_agent_context_agent ON agent_tool_context(agent_db_id);
CREATE INDEX IF NOT EXISTS idx_agent_context_lookup ON agent_tool_context(org_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_context_stale ON agent_tool_context(stale);

-- Assistant-agent routing
CREATE INDEX IF NOT EXISTS idx_asst_routing_org ON assistant_agent_routing(org_id);
CREATE INDEX IF NOT EXISTS idx_asst_routing_assistant ON assistant_agent_routing(assistant_id);
CREATE INDEX IF NOT EXISTS idx_asst_routing_agent ON assistant_agent_routing(agent_db_id);
CREATE INDEX IF NOT EXISTS idx_asst_routing_lookup ON assistant_agent_routing(org_id, assistant_id, enabled);
CREATE INDEX IF NOT EXISTS idx_asst_routing_priority ON assistant_agent_routing(org_id, assistant_id, priority);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Update updated_at on tool_definitions
CREATE TRIGGER IF NOT EXISTS trg_tool_definitions_updated
    AFTER UPDATE ON tool_definitions
    FOR EACH ROW
BEGIN
    UPDATE tool_definitions SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Update updated_at on tool_installations
CREATE TRIGGER IF NOT EXISTS trg_tool_installations_updated
    AFTER UPDATE ON tool_installations
    FOR EACH ROW
BEGIN
    UPDATE tool_installations SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================================
-- TOOL SYSTEM CONFIGURATION
-- ============================================================================

-- System-wide and org-specific configuration for tool management
CREATE TABLE IF NOT EXISTS tool_config (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE,  -- null = system default

    -- Agent tool limits (best practices)
    agent_tools_warn_threshold INTEGER NOT NULL DEFAULT 5,   -- Warn when adding 5th+ tool
    agent_tools_soft_limit INTEGER NOT NULL DEFAULT 8,       -- Strong warning at 8+
    agent_tools_hard_limit INTEGER NOT NULL DEFAULT 15,      -- Requires admin override
    allow_hard_limit_override INTEGER NOT NULL DEFAULT 0,    -- Can admins exceed hard limit?

    -- Execution limits
    max_concurrent_executions INTEGER NOT NULL DEFAULT 10,   -- Per org
    max_execution_timeout_ms INTEGER NOT NULL DEFAULT 600000, -- 10 minutes max
    privileged_requires_approval INTEGER NOT NULL DEFAULT 1, -- Privileged tools need approval

    -- Context limits
    max_context_tokens_per_agent INTEGER NOT NULL DEFAULT 2000, -- Tool context budget

    -- Audit settings
    log_all_executions INTEGER NOT NULL DEFAULT 1,
    log_params INTEGER NOT NULL DEFAULT 0,                   -- Don't log params by default (privacy)

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(org_id)  -- One config per org (null for system default)
);

-- Insert system defaults
INSERT OR IGNORE INTO tool_config (id, org_id, agent_tools_warn_threshold, agent_tools_soft_limit, agent_tools_hard_limit)
VALUES ('system_default', NULL, 5, 8, 15);

-- Tool config index
CREATE INDEX IF NOT EXISTS idx_tool_config_org ON tool_config(org_id);

-- ============================================================================
-- AGENT TOOL COUNT VIEW (For Limit Checking)
-- ============================================================================

-- Helper view to check tool counts per agent
CREATE VIEW IF NOT EXISTS agent_tool_counts AS
SELECT
    a.id as agent_db_id,
    a.org_id,
    a.agent_id,
    a.name as agent_name,
    COUNT(ata.id) as tool_count,
    tc.agent_tools_warn_threshold as warn_threshold,
    tc.agent_tools_soft_limit as soft_limit,
    tc.agent_tools_hard_limit as hard_limit,
    CASE
        WHEN COUNT(ata.id) >= tc.agent_tools_hard_limit THEN 'hard_limit'
        WHEN COUNT(ata.id) >= tc.agent_tools_soft_limit THEN 'soft_limit'
        WHEN COUNT(ata.id) >= tc.agent_tools_warn_threshold THEN 'warning'
        ELSE 'ok'
    END as limit_status
FROM agents a
LEFT JOIN agent_tool_assignments ata ON ata.agent_id = a.agent_id
    AND ata.org_id = a.org_id
    AND ata.enabled = 1
    AND ata.revoked_at IS NULL
LEFT JOIN tool_config tc ON tc.org_id = a.org_id
LEFT JOIN tool_config tc_default ON tc_default.org_id IS NULL
GROUP BY a.id, a.org_id, a.agent_id, a.name;

-- ============================================================================
-- SEED DATA: Categories
-- ============================================================================

-- Categories are defined in tool manifests, but we can define a reference table
CREATE TABLE IF NOT EXISTS tool_categories (
    id TEXT PRIMARY KEY,                    -- Category slug
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- Insert standard categories
INSERT OR IGNORE INTO tool_categories (id, name, description, icon, sort_order) VALUES
    ('orchestration', 'Orchestration', 'Multi-agent coordination and workflow management', '🎭', 1),
    ('mcp', 'MCP Integration', 'Model Context Protocol external tool integration', '🔌', 2),
    ('data', 'Data Access', 'Data retrieval, search, and database queries', '🔍', 3),
    ('dev', 'Development', 'Code management, CI/CD, and developer tools', '💻', 4),
    ('infrastructure', 'Infrastructure', 'Server, container, and cloud management', '🖥️', 5),
    ('content', 'Content & Docs', 'Documentation, communication, and content creation', '📝', 6),
    ('analytics', 'Analytics', 'Product analytics and user behavior', '📊', 7),
    ('model', 'Model Ops', 'LLM and prompt management', '🤖', 8),
    ('visualization', 'Visualization', 'Charts, diagrams, and dashboards', '📈', 9),
    ('governance', 'Governance', 'Security, compliance, and administration', '🔒', 10),
    ('video', 'Video', 'Video generation and editing', '🎬', 11),
    ('image', 'Image', 'Image generation and manipulation', '🖼️', 12),
    ('audio', 'Audio', 'Audio and voice processing', '🎵', 13),
    ('social', 'Social Media', 'Social media management', '📱', 14),
    ('marketing', 'Marketing', 'Marketing and content distribution', '📣', 15),
    ('ecommerce', 'E-commerce', 'Product and inventory management', '🛒', 16),
    ('legal', 'Legal', 'Legal and compliance automation', '⚖️', 17),
    ('hr', 'HR & Recruiting', 'Human resources and hiring', '👥', 18),
    ('finance', 'Finance', 'Accounting and financial tools', '💰', 19),
    ('healthcare', 'Healthcare', 'Medical and health tools', '🏥', 20),
    ('education', 'Education', 'Learning and training', '🎓', 21),
    ('realestate', 'Real Estate', 'Property and real estate tools', '🏠', 22),
    ('gaming', 'Gaming', 'Game development and entertainment', '🎮', 23),
    ('iot', 'IoT & Edge', 'Internet of Things and edge computing', '📡', 24),
    ('robotics', 'Robotics', 'Robotics and physical automation', '🤖', 25),
    ('science', 'Science', 'Scientific research tools', '🔬', 26),
    ('translation', 'Translation', 'Translation and localization', '🌐', 27),
    ('customer_service', 'Customer Service', 'Support and CX tools', '💬', 28),
    ('sales', 'Sales & CRM', 'Sales and customer management', '🤝', 29),
    ('project_management', 'Project Management', 'Task and project tools', '📋', 30);

-- ===== END schema-b2-tools.sql =====

-- ===== BEGIN schema-backups.sql =====
-- ============================================================================
-- Backup & Restore Schema
-- Phase D.1: Backup, restore, and migration support
-- ============================================================================

-- ============================================================================
-- BACKUP RECORDS
-- ============================================================================

-- Main backup records table
CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- Backup identification
    backup_type TEXT NOT NULL DEFAULT 'full'
        CHECK (backup_type IN ('full', 'quick', 'selective')),
    name TEXT,
    description TEXT,

    -- Status tracking
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'verifying', 'verified')),

    -- Timing
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,

    -- Storage info
    archive_path TEXT,                    -- e.g., /opt/quoxcore/backups/20250201_120000.tar.gz
    archive_size_bytes INTEGER,

    -- Manifest with checksums (JSON)
    -- Structure: { archiveHash, files: [{path, size, sha256, component}], components: {...}, totalFiles, totalBytes }
    manifest_json TEXT,

    -- Components included (JSON array)
    -- e.g., ["auth_db", "memory_system", "user_uploads"]
    components_json TEXT,

    -- Verification results (JSON)
    -- Structure: { valid, totalFiles, matches, mismatches: [], missing: [], verifiedAt }
    verification_json TEXT,

    -- Error info
    error_message TEXT,
    error_component TEXT,

    -- Who created it
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_backups_org ON backups(org_id);
CREATE INDEX IF NOT EXISTS idx_backups_status ON backups(status);
CREATE INDEX IF NOT EXISTS idx_backups_type ON backups(backup_type);
CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backups_org_created ON backups(org_id, created_at DESC);

-- ============================================================================
-- BACKUP COMPONENTS
-- ============================================================================

-- Defines what can be backed up
CREATE TABLE IF NOT EXISTS backup_components (
    id TEXT PRIMARY KEY,

    -- Component identification
    component_key TEXT UNIQUE NOT NULL,       -- e.g., "auth_db", "memory_system"
    name TEXT NOT NULL,
    description TEXT,

    -- Source path(s) - JSON array
    source_paths_json TEXT,                   -- ["path1", "path2"]

    -- Estimated size (for UI display)
    estimated_size_bytes INTEGER,

    -- Component type
    component_type TEXT NOT NULL DEFAULT 'directory'
        CHECK (component_type IN ('file', 'directory', 'database', 'docker_volume', 'api')),

    -- Backup method
    backup_method TEXT NOT NULL DEFAULT 'rsync'
        CHECK (backup_method IN ('rsync', 'copy', 'sqlite_backup', 'docker_cp', 'api_export', 'pg_dump', 'qdrant_snapshot')),

    -- Priority/order (lower = higher priority)
    priority INTEGER DEFAULT 100,

    -- Enabled by default for full backups
    default_enabled INTEGER DEFAULT 1,

    -- Category for UI grouping
    category TEXT DEFAULT 'data'
        CHECK (category IN ('core', 'data', 'config', 'workflow', 'infrastructure')),

    -- Icon name for UI
    icon TEXT DEFAULT 'folder'
);

-- ============================================================================
-- BACKUP SCHEDULES
-- ============================================================================

CREATE TABLE IF NOT EXISTS backup_schedules (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- Schedule name
    name TEXT NOT NULL,

    -- Cron-like schedule
    schedule_type TEXT NOT NULL DEFAULT 'daily'
        CHECK (schedule_type IN ('hourly', 'daily', 'weekly', 'monthly', 'custom')),
    cron_expression TEXT,                     -- For custom: "0 2 * * *"

    -- What time (for simple schedules)
    schedule_hour INTEGER DEFAULT 2,          -- Hour of day (0-23)
    schedule_minute INTEGER DEFAULT 0,        -- Minute (0-59)
    schedule_day_of_week INTEGER,             -- 0-6 for weekly (0=Sunday)
    schedule_day_of_month INTEGER,            -- 1-31 for monthly

    -- Backup type for this schedule
    backup_type TEXT NOT NULL DEFAULT 'full'
        CHECK (backup_type IN ('full', 'quick', 'selective')),

    -- Components (for selective) - JSON array
    components_json TEXT,

    -- Enabled
    enabled INTEGER NOT NULL DEFAULT 1,

    -- Last/next run
    last_run_at TEXT,
    next_run_at TEXT,
    last_backup_id TEXT REFERENCES backups(id) ON DELETE SET NULL,
    last_status TEXT,                         -- success, failed

    -- Retention for this schedule
    retention_days INTEGER DEFAULT 30,
    max_backups INTEGER DEFAULT 10,

    -- Created by
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_backup_schedules_org ON backup_schedules(org_id);
CREATE INDEX IF NOT EXISTS idx_backup_schedules_enabled ON backup_schedules(enabled);
CREATE INDEX IF NOT EXISTS idx_backup_schedules_next ON backup_schedules(next_run_at);

-- ============================================================================
-- RESTORE OPERATIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS restore_operations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,

    -- Status
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled', 'dry_run_complete', 'rolled_back')),

    -- Options
    dry_run INTEGER DEFAULT 0,
    components_json TEXT,                     -- Components to restore (null = all)

    -- Timing
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,

    -- Results
    files_restored INTEGER DEFAULT 0,
    bytes_restored INTEGER DEFAULT 0,

    -- Warnings and errors (JSON arrays)
    warnings_json TEXT,                       -- [{message, component, severity}, ...]
    error_message TEXT,
    error_component TEXT,

    -- Dry run preview (JSON)
    -- Structure: { wouldRestore: [{path, size, action}], conflicts: [], summary }
    preview_json TEXT,

    -- Performed by
    performed_by TEXT REFERENCES users(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_restore_ops_org ON restore_operations(org_id);
CREATE INDEX IF NOT EXISTS idx_restore_ops_backup ON restore_operations(backup_id);
CREATE INDEX IF NOT EXISTS idx_restore_ops_status ON restore_operations(status);
CREATE INDEX IF NOT EXISTS idx_restore_ops_created ON restore_operations(created_at DESC);

-- ============================================================================
-- BACKUP AUDIT LOG
-- ============================================================================

-- Dedicated audit table for backup operations (extends main audit_events)
CREATE TABLE IF NOT EXISTS backup_audit_log (
    id TEXT PRIMARY KEY,
    org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,

    -- Operation details
    operation TEXT NOT NULL,                  -- BACKUP_CREATED, BACKUP_VERIFIED, RESTORE_STARTED, etc.
    defcon_level TEXT NOT NULL DEFAULT 'GREEN'
        CHECK (defcon_level IN ('GREEN', 'BLUE', 'AMBER', 'ORANGE', 'RED')),

    -- References
    backup_id TEXT REFERENCES backups(id) ON DELETE SET NULL,
    restore_id TEXT REFERENCES restore_operations(id) ON DELETE SET NULL,

    -- Actor
    operator TEXT,                            -- User email or 'system'
    operator_id TEXT REFERENCES users(id) ON DELETE SET NULL,

    -- Result
    result TEXT NOT NULL DEFAULT 'pending'
        CHECK (result IN ('pending', 'success', 'failed', 'blocked', 'dry_run')),

    -- Timing
    duration_ms INTEGER,

    -- Details (JSON)
    -- Structure: { backupType, components, sizeBytes, filesCount, error, ... }
    metadata_json TEXT,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_backup_audit_org ON backup_audit_log(org_id);
CREATE INDEX IF NOT EXISTS idx_backup_audit_operation ON backup_audit_log(operation);
CREATE INDEX IF NOT EXISTS idx_backup_audit_defcon ON backup_audit_log(defcon_level);
CREATE INDEX IF NOT EXISTS idx_backup_audit_created ON backup_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_audit_backup ON backup_audit_log(backup_id);

-- ============================================================================
-- SEED DEFAULT BACKUP COMPONENTS
-- ============================================================================

INSERT OR IGNORE INTO backup_components (id, component_key, name, description, source_paths_json, component_type, backup_method, priority, category, icon, estimated_size_bytes) VALUES
-- Core (highest priority)
('comp_auth_db', 'auth_db', 'Auth Database', 'SQLite database with users, organizations, teams, permissions, sessions, MFA, HITL inbox', '["/opt/quoxcore/services/auth/data/auth.db"]', 'database', 'sqlite_backup', 10, 'core', 'database', 2000000),
('comp_collector_aee', 'collector_aee_db', 'Collector AEE Database', 'Agent event envelope audit trail — stores all conversation transcripts and tool executions', '["docker://quox-collector:/var/lib/quox/aee.db"]', 'database', 'sqlite_backup', 15, 'core', 'database', 50000000),
('comp_memory_db', 'memory_db', 'Memory Service Database', 'SQLite database for the memory service with FTS5 full-text search', '["docker://quox-memory:/var/lib/quox/memory.db"]', 'database', 'sqlite_backup', 16, 'core', 'database', 10000000),

-- Data
('comp_memory', 'memory_system', 'Memory System', 'QUOX episodic, semantic, and entity memory including knowledge maps and learned context', '["/opt/quoxcore/quox-memory/"]', 'directory', 'rsync', 20, 'data', 'brain', 150000),
('comp_vectors', 'qdrant_vectors', 'Vector Database', 'Qdrant vector embeddings for semantic search and RAG', '["/opt/quoxcore/qdrant-data/"]', 'directory', 'qdrant_snapshot', 30, 'data', 'layers', 100000),
('comp_uploads', 'user_uploads', 'User Uploads', 'Files uploaded by users including AI Vault, documents, and imported conversations', '["/opt/quoxcore/uploads/"]', 'directory', 'rsync', 40, 'data', 'folder-open', 350000000),
('comp_postgres', 'postgres_db', 'PostgreSQL Database', 'QuoxFlow workflow engine database — workflow definitions, execution history, and state', '["quoxflow"]', 'database', 'pg_dump', 45, 'data', 'database', 100000000),
('comp_org_logos', 'org_logos', 'Organization Logos', 'Uploaded organization logo and branding files', '["docker://quox-auth:/var/lib/quox/uploads/"]', 'directory', 'docker_cp', 46, 'data', 'image', 5000000),
('comp_quoxflow_evidence', 'quoxflow_evidence', 'QuoxFlow Evidence Files', 'Workflow execution evidence, artifacts, and audit attachments', '["docker://quox-quoxflow:/app/evidence/"]', 'directory', 'docker_cp', 47, 'data', 'file-check', 50000000),

-- Workflows
('comp_n8n', 'n8n_workflows', 'n8n Workflows', 'Workflow automation data including definitions, credentials, and execution history', '["/opt/n8n/data/"]', 'docker_volume', 'docker_cp', 50, 'workflow', 'git-branch', 50000000),
('comp_playbooks', 'quoxagent_playbooks', 'QuoxAgent Playbooks', 'Automation playbooks for fleet management (Tier A/B/C)', '["/opt/quoxcore/quoxagent/playbooks/"]', 'directory', 'rsync', 55, 'workflow', 'file-code', 400000),

-- Config
('comp_env', 'env_secrets', 'Environment Secrets', 'Environment configuration files with API keys, JWT secrets, and connection strings', '["/opt/quoxcore/services/auth/.env", "/opt/quoxcore/.env", "/opt/quoxcore/.env.local"]', 'file', 'copy', 60, 'config', 'key', 5000),
('comp_plugins', 'plugin_configs', 'Plugin Configs', 'Plugin manifest and configuration files', '["/opt/quoxcore/src/config/plugins/"]', 'directory', 'rsync', 70, 'config', 'puzzle', 100000),
('comp_agents', 'agent_definitions', 'Agent Definitions', 'Assistant and agent manifest files defining capabilities and personalities', '["/opt/quoxcore/src/config/entities/assistants/"]', 'directory', 'rsync', 80, 'config', 'users', 100000),
('comp_tools', 'tool_definitions', 'Tool Definitions', 'Tool and capability specification files', '["/opt/quoxcore/src/config/entities/tools/"]', 'directory', 'rsync', 90, 'config', 'wrench', 50000),
('comp_ssl_certs', 'ssl_certs', 'SSL Certificates', 'TLS/SSL certificates and private keys for HTTPS services', '["/etc/ssl/quox/", "certs/"]', 'file', 'copy', 91, 'config', 'lock', 50000),
('comp_ssh_keys', 'ssh_keys', 'SSH Keys', 'SSH key pairs used for bastion access and fleet deployment', '["/opt/quoxcore/.ssh/"]', 'directory', 'copy', 92, 'config', 'key', 20000),

-- Infrastructure
('comp_hosts', 'host_configs', 'Host Configs', 'Infrastructure host definitions and topology configuration', '["/opt/quoxcore/src/config/hosts.js"]', 'file', 'copy', 100, 'infrastructure', 'server', 20000),
('comp_mha_configs', 'quoxagent_configs', 'QuoxAgent Configs', 'QuoxAgent deployment configuration files', '["/opt/quoxcore/quoxagent/configs/"]', 'directory', 'rsync', 110, 'infrastructure', 'settings', 20000),
('comp_bastion_fleet', 'bastion_fleet_registry', 'Bastion Fleet Registry', 'Fleet host registry and topology data from the bastion', '["/opt/quoxcore/QuoxBastion/data/fleet.json", "/opt/quoxcore/QuoxBastion/data/hosts/"]', 'file', 'copy', 115, 'infrastructure', 'network', 100000),
('comp_bastion_audit', 'bastion_audit_logs', 'Bastion Audit Logs', 'SSH session audit logs and command history from the bastion', '["rsync://gw-01:/var/log/quoxbastion/"]', 'directory', 'rsync', 120, 'infrastructure', 'shield', 20000000);

-- Additional components discovered in BR-2 audit (2026-03-13)
INSERT OR IGNORE INTO backup_components (id, component_key, name, description, source_paths_json, component_type, backup_method, priority, category, icon, estimated_size_bytes) VALUES
-- Core databases missing from original seed
('comp_tasks_db', 'tasks_db', 'Tasks Database', 'SQLite database for objectives, tasks, and task execution state', '["docker://quox-tasks:/var/lib/quox/tasks.db"]', 'database', 'sqlite_backup', 17, 'core', 'database', 20000000),
('comp_volt_db', 'collector_volt_db', 'VOLT Receipt Chain', 'Verifiable Operations Ledger — append-only audit trail for all operations', '["docker://quox-collector:/var/lib/quox/volt.db"]', 'database', 'sqlite_backup', 18, 'core', 'database', 30000000),
('comp_feedback_db', 'collector_feedback_db', 'Feedback Database', 'User feedback ratings and router feedback for response quality tracking', '["docker://quox-collector:/var/lib/quox/feedback.db"]', 'database', 'sqlite_backup', 19, 'core', 'database', 5000000),
('comp_ward_db', 'collector_ward_db', 'WARD Receipt Chain', 'Write-once Append-only Receipt Digests — immutable receipt chain', '["docker://quox-collector:/var/lib/quox/ward.db"]', 'database', 'sqlite_backup', 19, 'core', 'database', 10000000),

-- Collector data not previously covered
('comp_collector_images', 'collector_images', 'AI-Generated Images', 'Images generated by AI agents stored in the collector volume', '["docker://quox-collector:/var/lib/quox/images/"]', 'directory', 'docker_cp', 55, 'data', 'image', 200000000),
('comp_collector_cache', 'collector_config_cache', 'Collector Config Cache', 'Cached tool manifests, entity schemas, and agent config in collector', '["docker://quox-collector:/var/lib/quox/cache/"]', 'directory', 'docker_cp', 85, 'config', 'folder', 5000000),

-- Files service data
('comp_files_data', 'files_data', 'Files Service Data', 'File storage metadata, folder structures, and stored files from the files service', '["docker://quox-files:/var/lib/quox/files/"]', 'directory', 'docker_cp', 48, 'data', 'folder-open', 100000000),

-- Orchestrator state
('comp_orchestrator_data', 'orchestrator_data', 'Orchestrator State', 'Orchestrator session state, delegation history, and routing cache', '["docker://quox-orchestrator:/var/lib/quox/"]', 'directory', 'docker_cp', 75, 'data', 'layers', 10000000),

-- Collector Claude context
('comp_claude_context', 'collector_claude_context', 'Claude Context Cache', 'Cached Claude conversation context and system prompts', '["docker://quox-collector:/var/lib/quox/claude-context/"]', 'directory', 'docker_cp', 88, 'config', 'brain', 20000000);

-- ===== END schema-backups.sql =====

-- ===== BEGIN schema-bastion-hitl.sql =====
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

-- ===== END schema-bastion-hitl.sql =====

-- ===== BEGIN schema-c1.sql =====
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

-- ===== END schema-c1.sql =====

-- ===== BEGIN schema-consent.sql =====
-- Schema for AI Data Consent Tracking (Security Issue #72)
-- This addresses: "High: Third-party AI providers receive data without consent"

-- ============================================================================
-- USER CONSENT PREFERENCES
-- ============================================================================

-- User consent preferences for AI data sharing
CREATE TABLE IF NOT EXISTS user_consent (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

    -- Third-party AI provider consent
    -- Must be explicitly granted before sending data to OpenAI, Anthropic, etc.
    ai_data_sharing_consent INTEGER NOT NULL DEFAULT 0,
    ai_data_sharing_consent_at TEXT,  -- When consent was granted

    -- Granular provider consent (JSON object: { "openai": true, "anthropic": true, ... })
    provider_consent_json TEXT DEFAULT '{}',

    -- Consent version tracking (for re-consent on policy changes)
    consent_version TEXT NOT NULL DEFAULT '1.0',

    -- Audit fields
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    ip_address TEXT,  -- IP when consent was given
    user_agent TEXT   -- User agent when consent was given
);

CREATE INDEX IF NOT EXISTS idx_user_consent_user ON user_consent(user_id);

-- ============================================================================
-- CONSENT CHANGE LOG (Audit Trail)
-- ============================================================================

-- Audit trail for all consent changes
CREATE TABLE IF NOT EXISTS consent_change_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- What changed
    consent_type TEXT NOT NULL,  -- 'ai_data_sharing', 'provider_specific', etc.
    old_value TEXT,
    new_value TEXT,

    -- Context
    reason TEXT,  -- 'user_action', 'policy_update', 'gdpr_request', etc.

    -- Audit metadata
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_consent_log_user ON consent_change_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_log_type ON consent_change_log(consent_type, created_at DESC);

-- ============================================================================
-- AI PROVIDER CALL LOG (for consent verification audit)
-- ============================================================================

-- Log of AI provider calls for audit purposes
CREATE TABLE IF NOT EXISTS ai_provider_calls (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    org_id TEXT REFERENCES orgs(id),

    -- Provider details
    provider TEXT NOT NULL,  -- 'openai', 'anthropic', 'perplexity', 'gemini'
    model TEXT,

    -- Consent status at time of call
    consent_verified INTEGER NOT NULL DEFAULT 0,
    consent_user_id TEXT,  -- User whose consent was checked

    -- Call metadata (no PII)
    endpoint TEXT,  -- 'chat', 'embeddings', 'completions'
    success INTEGER NOT NULL DEFAULT 1,
    blocked_reason TEXT,  -- If blocked: 'no_consent', 'consent_expired', etc.

    -- Audit
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_calls_user ON ai_provider_calls(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_calls_provider ON ai_provider_calls(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_calls_blocked ON ai_provider_calls(blocked_reason, created_at DESC) WHERE blocked_reason IS NOT NULL;

-- ===== END schema-consent.sql =====

-- ===== BEGIN schema-cw-10.sql =====
-- CW-10.1 — Widget Simulation Scenarios
-- A scenario = a test the widget runs against its own assistant. Admin defines
-- the visitor turn(s) + expectations; the simulation runner invokes the chat
-- endpoint and scores the response against the rubric.
--
-- Seeded security scenarios (CW-10.3) ship with is_seed=1 so admins can tell
-- the library's baseline apart from their own additions. Seeded rows are
-- re-upserted at startup if their content hash changes.

CREATE TABLE IF NOT EXISTS widget_scenarios (
    id TEXT PRIMARY KEY,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,

    -- Identity
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general', -- 'faq' | 'security' | 'tool_use' | 'off_topic' | 'edge_case' | 'general'

    -- Test definition
    user_message TEXT NOT NULL,
    -- JSON: { must_include?: [string], must_not_include?: [string], expected_topic?: string,
    --         expected_tool?: string, expected_handoff?: boolean, max_response_length?: int }
    rubric_json TEXT NOT NULL DEFAULT '{}',

    -- Classification
    is_seed INTEGER NOT NULL DEFAULT 0,
    severity TEXT NOT NULL DEFAULT 'low', -- 'low' | 'medium' | 'high' (security only)

    -- Last result (for quick widget summary without re-running)
    last_run_at TEXT,
    last_score REAL,
    last_passed INTEGER,
    last_notes TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(widget_id, name)
);

CREATE INDEX IF NOT EXISTS idx_scenarios_widget ON widget_scenarios(widget_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_category ON widget_scenarios(widget_id, category);
CREATE INDEX IF NOT EXISTS idx_scenarios_seed ON widget_scenarios(widget_id, is_seed);

-- CW-10.2 — Simulation run summary (aggregate over a batch of scenario runs)
-- One row per "Run all" / "Run category" / "Run single" invocation. Used to
-- drive the publish-gate check: latest run security_score must be >=70 before
-- a widget can publish to a production domain.

CREATE TABLE IF NOT EXISTS widget_simulation_runs (
    id TEXT PRIMARY KEY,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,

    triggered_by TEXT REFERENCES users(id),
    scope TEXT NOT NULL DEFAULT 'all', -- 'all' | 'category:<name>' | 'single:<scenario_id>'

    total INTEGER NOT NULL DEFAULT 0,
    passed INTEGER NOT NULL DEFAULT 0,
    warned INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    security_score REAL, -- 0-100, null when no security scenarios ran

    duration_ms INTEGER,
    error_message TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sim_runs_widget ON widget_simulation_runs(widget_id);
CREATE INDEX IF NOT EXISTS idx_sim_runs_finished ON widget_simulation_runs(widget_id, finished_at);

-- ===== END schema-cw-10.sql =====

-- ===== BEGIN schema-cw-9.sql =====
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
    builtin_kind TEXT,                           -- 'lead_capture' | 'human_handoff' | 'redirect_url' (when tool_type='builtin')

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

-- ===== END schema-cw-9.sql =====

-- ===== BEGIN schema-d5.sql =====
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

-- ===== END schema-d5.sql =====

-- ===== BEGIN schema-files.sql =====
-- FU-1 — file_objects
-- One row per user-uploaded or system-generated file. Physical blob lives
-- on disk at blob_path; virtual_path is the human-readable address scoped
-- to (org_id, namespace). Content-addressed de-dup: two uploads with the
-- same SHA-256 in the same org share one blob (reference-counted by row).

CREATE TABLE IF NOT EXISTS file_objects (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    created_by      TEXT NOT NULL REFERENCES users(id),
    namespace       TEXT NOT NULL,
    virtual_path    TEXT NOT NULL,
    filename        TEXT NOT NULL,
    mime            TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    sha256          TEXT NOT NULL,
    blob_path       TEXT NOT NULL,
    source_plugin   TEXT,
    source_ref      TEXT,
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'active', -- 'active' | 'deleted'
    deleted_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_file_objects_org_ns ON file_objects(org_id, namespace, status);
CREATE INDEX IF NOT EXISTS idx_file_objects_sha256 ON file_objects(sha256);
CREATE INDEX IF NOT EXISTS idx_file_objects_source ON file_objects(source_plugin, source_ref);
CREATE INDEX IF NOT EXISTS idx_file_objects_virtual_path ON file_objects(virtual_path);
CREATE INDEX IF NOT EXISTS idx_file_objects_org_status ON file_objects(org_id, status, created_at);

-- ===== END schema-files.sql =====

-- ===== BEGIN schema-invite-dedup.sql =====
-- ============================================================================
-- Security Issue #88: Prevent invite double-spend via unique constraint
-- This creates a unique index to prevent the same invite from being accepted
-- multiple times at the database level (defense-in-depth)
-- ============================================================================

-- Create unique partial index: only one accepted record per invite
-- This allows multiple pending/expired/revoked records but only ONE accepted
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_single_acceptance
ON invites(id) WHERE status = 'accepted';

-- Also create an index on (accepted_by, org_id) to speed up membership checks
-- and prevent a user from accepting multiple invites to the same org simultaneously
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_user_org_accepted
ON invites(accepted_by, org_id) WHERE status = 'accepted' AND accepted_by IS NOT NULL;

-- ===== END schema-invite-dedup.sql =====

-- ===== BEGIN schema-marketplace-s3.sql =====
-- ============================================================================
-- Marketplace Schema — Stream 3 (Install Tracking + User Reviews)
-- ============================================================================

-- Plugin installs (tracks who installed what)
CREATE TABLE IF NOT EXISTS marketplace_installs (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    listing_version_id TEXT NOT NULL REFERENCES listing_versions(id),
    org_id TEXT NOT NULL REFERENCES orgs(id),
    installed_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'uninstalled')),
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    uninstalled_at TEXT,
    UNIQUE(listing_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_mp_installs_listing ON marketplace_installs(listing_id);
CREATE INDEX IF NOT EXISTS idx_mp_installs_org ON marketplace_installs(org_id);
CREATE INDEX IF NOT EXISTS idx_mp_installs_status ON marketplace_installs(status);

-- User reviews / ratings
CREATE TABLE IF NOT EXISTS marketplace_reviews (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    user_id TEXT NOT NULL,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    title TEXT,
    body TEXT,
    status TEXT NOT NULL DEFAULT 'published'
        CHECK (status IN ('published', 'hidden', 'flagged')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(listing_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_mp_reviews_listing ON marketplace_reviews(listing_id);
CREATE INDEX IF NOT EXISTS idx_mp_reviews_user ON marketplace_reviews(user_id);

-- Listing stats (denormalized for fast browse queries)
CREATE TABLE IF NOT EXISTS listing_stats (
    listing_id TEXT PRIMARY KEY REFERENCES listings(id),
    install_count INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    average_rating REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== END schema-marketplace-s3.sql =====

-- ===== BEGIN schema-marketplace.sql =====
-- ============================================================================
-- Marketplace Schema (Stream 2: Developer Portal)
-- ============================================================================

-- Seller profiles (one per org)
CREATE TABLE IF NOT EXISTS sellers (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL UNIQUE REFERENCES orgs(id),
    display_name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    trust_level TEXT NOT NULL DEFAULT 'registered'
        CHECK (trust_level IN ('registered', 'developer', 'verified', 'trusted_partner', 'official')),
    github_username TEXT,
    bio TEXT,
    website TEXT,
    logo_path TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sellers_org ON sellers(org_id);
CREATE INDEX IF NOT EXISTS idx_sellers_slug ON sellers(slug);
CREATE INDEX IF NOT EXISTS idx_sellers_trust ON sellers(trust_level);

-- Marketplace listings
CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    seller_id TEXT NOT NULL REFERENCES sellers(id),
    org_id TEXT NOT NULL REFERENCES orgs(id),
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    product_type TEXT NOT NULL DEFAULT 'plugin'
        CHECK (product_type IN ('plugin', 'workflow', 'agent', 'agent_team', 'community')),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'submitted', 'in_review', 'published', 'suspended', 'delisted')),
    price_cents INTEGER NOT NULL DEFAULT 0,
    price_model TEXT NOT NULL DEFAULT 'free'
        CHECK (price_model IN ('free', 'one_time', 'subscription_monthly', 'subscription_yearly')),
    commission_rate REAL NOT NULL DEFAULT 0.20,
    category TEXT,
    tags_json TEXT DEFAULT '[]',
    icon_path TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    published_at TEXT,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_org ON listings(org_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_slug ON listings(slug);
CREATE INDEX IF NOT EXISTS idx_listings_product_type ON listings(product_type);

-- Listing versions (each submission is a version)
CREATE TABLE IF NOT EXISTS listing_versions (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    version TEXT NOT NULL,
    changelog TEXT,
    package_path TEXT,
    package_hash TEXT,
    package_size_bytes INTEGER,
    review_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (review_status IN ('pending', 'automated_passed', 'automated_failed', 'approved', 'rejected', 'changes_requested', 'yanked')),
    automated_checks_json TEXT DEFAULT '{}',
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_notes TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(listing_id, version)
);

CREATE INDEX IF NOT EXISTS idx_listing_versions_listing ON listing_versions(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_versions_status ON listing_versions(review_status);

-- Listing screenshots
CREATE TABLE IF NOT EXISTS listing_screenshots (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    file_path TEXT NOT NULL,
    caption TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_listing_screenshots_listing ON listing_screenshots(listing_id);

-- Submission reviews (admin review trail)
CREATE TABLE IF NOT EXISTS submission_reviews (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES listing_versions(id),
    reviewer_id TEXT NOT NULL,
    action TEXT NOT NULL
        CHECK (action IN ('approve', 'reject', 'request_changes', 'yank')),
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_submission_reviews_version ON submission_reviews(version_id);

-- ===== END schema-marketplace.sql =====

-- ===== BEGIN schema-mcp-tokens.sql =====
-- ============================================================================
-- MCP TOKENS (MCPB-HARDEN-P2 — per-user MCP credentials)
-- ============================================================================

-- Per-user MCP tokens; token_hash is SHA-256 hex of the raw bearer value
CREATE TABLE IF NOT EXISTS mcp_tokens (
    id           TEXT PRIMARY KEY,              -- ULID
    user_id      TEXT NOT NULL,
    org_id       TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,          -- SHA-256 hex of the raw token
    label        TEXT NOT NULL,                 -- e.g. "Adam's MacBook Pro"
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at   TEXT,
    CHECK (revoked_at IS NULL OR revoked_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_org  ON mcp_tokens(org_id);

-- ===== END schema-mcp-tokens.sql =====

-- ===== BEGIN schema-messages.sql =====
-- ============================================================================
-- Messages & Conversations Schema
-- Conversation audit trail for compliance and HITL integration
--
-- AOCL/AEE Alignment:
-- - aee_envelope_id: Links to AEE envelope (all layers)
-- - correlation_id: Maps to AEE corr field for conversation tracking
-- - sender_type/id: Maps to AEE from field
-- - aocl_layers_json: Tracks which AOCL layers processed (L0-L10)
-- - verify_status: L8 Verify output validation result
-- - requires_approval: L3 Policy HITL integration
-- - prev_message_hash/message_hash: L10 Audit immutable chain
--
-- See: /opt/quoxcore/docs/AOCL.md
-- ============================================================================

-- ============================================================================
-- CONVERSATIONS (threads/sessions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- Scope (who owns this conversation)
    scope_type TEXT NOT NULL DEFAULT 'user',  -- user, team, division, org
    scope_id TEXT NOT NULL,                   -- user_id, team_id, division_id, or org_id

    -- Conversation metadata
    title TEXT,                             -- Auto-generated or user-set title
    summary TEXT,                           -- AI-generated summary
    agent_id TEXT,                          -- Primary agent/assistant (e.g., 'quox', 'sentinel')

    -- Status
    status TEXT NOT NULL DEFAULT 'active',  -- active, archived, deleted

    -- Counters (denormalized for performance)
    message_count INTEGER DEFAULT 0,
    token_count_in INTEGER DEFAULT 0,
    token_count_out INTEGER DEFAULT 0,

    -- Timestamps
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_message_at TEXT,
    archived_at TEXT,

    -- Audit
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- MESSAGES (individual messages in conversations)
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,                    -- ULID
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- Message identification
    sequence_num INTEGER NOT NULL,          -- Order within conversation
    parent_id TEXT REFERENCES messages(id), -- For threaded replies

    -- Sender
    role TEXT NOT NULL,                     -- user, assistant, system, tool
    sender_type TEXT NOT NULL,              -- human, agent, system
    sender_id TEXT,                         -- user_id or agent_id
    sender_name TEXT,                       -- Display name at time of message

    -- Content
    content TEXT NOT NULL,                  -- Message content (may be markdown)
    content_type TEXT DEFAULT 'text',       -- text, markdown, json, image, file

    -- Attachments (JSON array)
    -- Structure: [{ id, filename, mime_type, size_bytes, url }]
    attachments_json TEXT,

    -- Tool calls and results (JSON)
    -- Structure for tool calls: [{ id, name, arguments }]
    -- Structure for tool results: { tool_call_id, output, error }
    tool_calls_json TEXT,
    tool_result_json TEXT,

    -- Token usage
    tokens_in INTEGER,
    tokens_out INTEGER,

    -- Model/provider info
    model TEXT,                             -- e.g., 'claude-3-opus', 'gpt-4'
    provider TEXT,                          -- e.g., 'anthropic', 'openai'

    -- Processing metadata
    processing_time_ms INTEGER,
    finish_reason TEXT,                     -- stop, length, tool_calls, error

    -- L8 Verify status (output validation)
    verify_status TEXT,                     -- passed, warning, failed, skipped
    verify_flags_json TEXT,                 -- JSON array of verification flags raised

    -- HITL integration
    requires_approval INTEGER DEFAULT 0,    -- Flagged for HITL review
    approval_status TEXT,                   -- pending, approved, rejected
    approved_by TEXT REFERENCES users(id),
    approved_at TEXT,

    -- Audit trail
    edited INTEGER DEFAULT 0,
    edited_at TEXT,
    deleted_at TEXT,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    -- AEE correlation (links to AEE envelope system)
    aee_envelope_id TEXT,                   -- AEE envelope ID if applicable
    correlation_id TEXT,                    -- Conversation/request correlation

    -- AOCL Layer Tracking (which layers processed this message)
    -- JSON array: ["L0", "L2", "L5", "L7", "L9", "L10"]
    aocl_layers_json TEXT,

    -- Audit Chain (L10 Audit immutability)
    -- SHA256 hash of: prev_hash + id + content + created_at
    prev_message_hash TEXT,                 -- Hash of previous message in conversation
    message_hash TEXT                       -- Hash of this message for chain verification
);

-- ============================================================================
-- MESSAGE REACTIONS (user feedback on messages)
-- ============================================================================

CREATE TABLE IF NOT EXISTS message_reactions (
    id TEXT PRIMARY KEY,                    -- ULID
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Reaction type
    reaction_type TEXT NOT NULL,            -- thumbs_up, thumbs_down, flag, bookmark

    -- Optional feedback
    feedback_text TEXT,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(message_id, user_id, reaction_type)
);

-- ============================================================================
-- CONVERSATION PARTICIPANTS (for multi-user conversations)
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversation_participants (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Role in conversation
    role TEXT NOT NULL DEFAULT 'participant',  -- owner, moderator, participant, observer

    -- Notification preferences
    notify_on_message INTEGER DEFAULT 1,
    notify_on_mention INTEGER DEFAULT 1,

    -- Timestamps
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_read_at TEXT,
    left_at TEXT,

    UNIQUE(conversation_id, user_id)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Conversations
CREATE INDEX IF NOT EXISTS idx_conversations_org ON conversations(org_id);
CREATE INDEX IF NOT EXISTS idx_conversations_scope ON conversations(org_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(org_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(org_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(org_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(org_id, created_at DESC);

-- Messages
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_messages_org ON messages(org_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_type, sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_hitl ON messages(org_id, requires_approval, approval_status);
CREATE INDEX IF NOT EXISTS idx_messages_correlation ON messages(correlation_id);
CREATE INDEX IF NOT EXISTS idx_messages_aee ON messages(aee_envelope_id);
CREATE INDEX IF NOT EXISTS idx_messages_verify ON messages(org_id, verify_status);
CREATE INDEX IF NOT EXISTS idx_messages_hash ON messages(message_hash);

-- Reactions
CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_user ON message_reactions(user_id);
CREATE INDEX IF NOT EXISTS idx_reactions_type ON message_reactions(message_id, reaction_type);

-- Participants
CREATE INDEX IF NOT EXISTS idx_participants_conversation ON conversation_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON conversation_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_participants_active ON conversation_participants(conversation_id, left_at);

-- ============================================================================
-- TRIGGERS (update counters and timestamps)
-- ============================================================================

-- Update conversation message count and last_message_at on new message
CREATE TRIGGER IF NOT EXISTS trg_message_insert
AFTER INSERT ON messages
BEGIN
    UPDATE conversations
    SET message_count = message_count + 1,
        last_message_at = NEW.created_at,
        token_count_in = token_count_in + COALESCE(NEW.tokens_in, 0),
        token_count_out = token_count_out + COALESCE(NEW.tokens_out, 0),
        updated_at = datetime('now')
    WHERE id = NEW.conversation_id;
END;

-- Decrement count on message delete (soft delete)
CREATE TRIGGER IF NOT EXISTS trg_message_soft_delete
AFTER UPDATE OF deleted_at ON messages
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
    UPDATE conversations
    SET message_count = message_count - 1,
        updated_at = datetime('now')
    WHERE id = NEW.conversation_id;
END;

-- ===== END schema-messages.sql =====

-- ===== BEGIN schema-powers-mcp-hosted.sql =====
-- POWERS-P2.A: Powers MCP Hosted schema (SQLite)
-- Supports mcp_hosted executor_type — cloned repos built into Docker images
-- and managed by the powers-host service.
--
-- NOTE on tool_definitions.status:
--   Only 'available' | 'beta' | 'deprecated' | 'disabled' | 'coming_soon' are legal
--   per feedback_tool_definitions_status_check.md.
--   When P2.C writes a new mcp_hosted row, set status='beta' while building/idle,
--   status='disabled' on permanent failure. Never 'installed' or 'install_pending_*'.

-- ============================================================================
-- powers_hosted: one row per deployed mcp_hosted tool
-- ============================================================================
CREATE TABLE IF NOT EXISTS powers_hosted (
  tool_id TEXT PRIMARY KEY REFERENCES tool_definitions(id) ON DELETE CASCADE,
  org_id TEXT REFERENCES orgs(id),     -- POWERS-VAULT-MIGRATION B.1: nullable for legacy rows; app enforces non-null on new writes
  repo_url TEXT NOT NULL,
  repo_ref TEXT DEFAULT 'HEAD',
  language TEXT,                       -- node | python | go | unknown
  dockerfile_source TEXT,              -- 'repo' | 'generated-node' | 'generated-python' | 'generated-go'
  image_tag TEXT,                      -- quox-power-<tool_id>:latest
  build_state TEXT NOT NULL,           -- pending | building | built | failed
  build_log_url TEXT,
  build_failed_reason TEXT,
  -- process_state is null until P2.B ships the process supervisor.
  -- Legal values (set by P2.B): never_started | running | idle | crashed | disabled
  process_state TEXT,
  container_id TEXT,                   -- last known docker container id (set by P2.B)
  last_invocation_at TEXT,             -- ISO-8601 UTC (set by P2.B/D)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_powers_hosted_build_state ON powers_hosted(build_state);
CREATE INDEX IF NOT EXISTS idx_powers_hosted_process_state ON powers_hosted(process_state);
CREATE INDEX IF NOT EXISTS idx_powers_hosted_org ON powers_hosted(org_id);

-- ============================================================================
-- powers_credentials: encrypted env vars for spawned containers
--
-- DEPRECATED — POWERS-VAULT-MIGRATION Phase A (2026-05-21)
-- New writes go to integration_credentials (Vault) via powersCredentialAdapter.js.
-- Label convention: 'powers:{tool_definitions.id}:{key}', integration_type='custom'.
-- This table is retained for the Phase B retention window (drop after ~30 days).
-- Read path: processSupervisor.js falls back here for pre-migration deploys only.
-- ============================================================================
CREATE TABLE IF NOT EXISTS powers_credentials (
  tool_id TEXT NOT NULL REFERENCES tool_definitions(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_encrypted BLOB NOT NULL,       -- AES-256-GCM, same encoding as P1 mcp_auth_value
  PRIMARY KEY (tool_id, key)
);

-- ============================================================================
-- powers_build_logs: streaming build stdout/stderr per tool
-- Rotation policy: keep last 1000 lines per tool (enforced by powers-host at write time)
-- ============================================================================
CREATE TABLE IF NOT EXISTS powers_build_logs (
  tool_id TEXT NOT NULL REFERENCES tool_definitions(id) ON DELETE CASCADE,
  org_id TEXT REFERENCES orgs(id),     -- POWERS-VAULT-MIGRATION B.2: nullable for legacy rows
  line_no INTEGER NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  stream TEXT NOT NULL,                -- 'stdout' | 'stderr'
  content TEXT NOT NULL,
  PRIMARY KEY (tool_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_powers_build_logs_tool_ts ON powers_build_logs(tool_id, ts);
CREATE INDEX IF NOT EXISTS idx_powers_build_logs_org ON powers_build_logs(org_id);

-- ===== END schema-powers-mcp-hosted.sql =====

-- ===== BEGIN schema-qcx-publish-claims.sql =====
-- QCX-2.4 — Widget publish governance claims.
--
-- Every successful widget publish writes a row here. claim_id +
-- manifest_hash are the WARD-compatible identifiers; canonical_payload
-- is the RFC 8785 JSON canonicalisation so a downstream witness can
-- rehash + verify without re-canonicalising. Append-only — claims are
-- never mutated, only new rows added on re-publish.

CREATE TABLE IF NOT EXISTS widget_publish_claims (
    claim_id TEXT PRIMARY KEY,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,

    manifest_hash TEXT NOT NULL,          -- sha256 hex of canonical_payload
    canonical_payload TEXT NOT NULL,      -- RFC 8785 JSON bytes (verifiable)
    payload_json TEXT NOT NULL,           -- human-readable JSON (same fields, unsorted)

    security_score INTEGER,               -- null when dev_only
    simulation_run_id TEXT,               -- null when dev_only
    dev_only INTEGER NOT NULL DEFAULT 0,  -- 1 when published via dev-domain bypass
    published_by_user_id TEXT NOT NULL,

    issued_at TEXT NOT NULL               -- ISO-8601, equals published_at
);

CREATE INDEX IF NOT EXISTS idx_widget_publish_claims_widget ON widget_publish_claims(widget_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_widget_publish_claims_org ON widget_publish_claims(org_id, issued_at DESC);

-- ===== END schema-qcx-publish-claims.sql =====

-- ===== BEGIN schema-qcx-visitors.sql =====
-- QCX-3.2 — Widget visitor memory.
--
-- Per (widget × visitor_id). Records first_seen / last_seen /
-- identified_attrs / conversation_count so a returning visitor gets
-- recognised and the collector can inject a "continue where you left
-- off" preamble into the LLM system prompt.
--
-- No raw secrets / passwords / free-form attrs — auth.lib.widgetVisitorMemory
-- ATTR_ALLOWLIST drops everything outside the supported set before write.

CREATE TABLE IF NOT EXISTS widget_visitors (
    visitor_id TEXT NOT NULL,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,

    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    conversation_count INTEGER NOT NULL DEFAULT 0,

    -- JSON of allowlisted identify-attrs. Merged (not overwritten) on upsert
    -- by widgetVisitorMemory.mergeIdentifiedAttrs().
    identified_attrs_json TEXT NOT NULL DEFAULT '{}',

    -- Reserved for QCX-3 follow-ons (topic tracking, style profile).
    topics_json TEXT NOT NULL DEFAULT '[]',
    style_profile_json TEXT NOT NULL DEFAULT '{}',

    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    PRIMARY KEY (widget_id, visitor_id)
);

CREATE INDEX IF NOT EXISTS idx_widget_visitors_org_last_seen ON widget_visitors(org_id, last_seen DESC);

-- ===== END schema-qcx-visitors.sql =====

-- ===== BEGIN schema-quoxchat.sql =====
-- QuoxChat Schema (Stream CW-1)
-- Website chat widget management tables

-- NOTE: the original schema-quoxchat.sql set `PRAGMA journal_mode = WAL;`
-- and `PRAGMA synchronous = NORMAL;` here. Both PRAGMAs are removed in this
-- baseline — runMigrations() applies this file inside a BEGIN/COMMIT
-- transaction, and SQLite forbids changing journal_mode/synchronous inside
-- a transaction ("Safety level may not be changed inside a transaction").
-- db/index.js's getDb() already sets `journal_mode = WAL` before
-- runMigrations() is invoked, so this is a no-op removal, not a behavior
-- change.

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

-- ===== END schema-quoxchat.sql =====

-- ===== BEGIN schema-reg.sql =====
-- REG-0: Universal Asset Registry foundation (2026-04-12)
--
-- Introduces four governance-metadata tables as the foundation for
-- Phase B "make Quox evidential":
--
--   model_definitions         — model catalog with risk tier, data residency
--   asset_owners              — polymorphic (asset_type, asset_id) → owner
--   asset_data_classes        — polymorphic data classification labels
--   data_class_definitions    — reference/vocabulary for standard classes
--
-- Plus ALTER TABLE additions on the existing `agents` table for governance
-- columns. The agents table lives in schema-b2-tools.sql — we augment it
-- rather than duplicate.
--
-- Pattern: conditional application at auth service startup (db/index.js)
-- guarded by a check for model_definitions existence. Matches how
-- schema-b1.sql / schema-b2-tools.sql are loaded.

-- ============================================================================
-- MODEL REGISTRY
-- ============================================================================

CREATE TABLE IF NOT EXISTS model_definitions (
    id TEXT PRIMARY KEY,                    -- ULID
    model_id TEXT UNIQUE NOT NULL,          -- 'claude-sonnet-4-6', 'gpt-5.4'
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL,                 -- 'anthropic', 'openai', 'gemini', 'local'
    provider_model_id TEXT,                 -- exact API string (may differ from model_id)

    -- Capabilities
    context_window INTEGER,                 -- tokens
    supports_vision INTEGER DEFAULT 0,
    supports_tools INTEGER DEFAULT 1,
    supports_streaming INTEGER DEFAULT 1,

    -- Cost tracking
    cost_per_input_mtok REAL,               -- USD per million input tokens
    cost_per_output_mtok REAL,

    -- Governance metadata (the whole point of REG)
    risk_tier TEXT DEFAULT 'standard' CHECK (risk_tier IN ('low', 'standard', 'high', 'critical')),
    data_residency TEXT,                    -- 'us', 'eu', 'global', 'on-premise'
    compliance_certifications TEXT DEFAULT '[]',  -- JSON array: ['SOC2', 'HIPAA', 'ISO27001']
    requires_approval INTEGER DEFAULT 0,    -- 1 = org admin must approve before use

    -- Lifecycle
    status TEXT DEFAULT 'available' CHECK (status IN ('available', 'beta', 'deprecated', 'disabled')),
    deprecated_at TEXT,
    replacement_model_id TEXT REFERENCES model_definitions(id),

    -- Metadata
    knowledge_cutoff TEXT,                  -- ISO date string
    is_core INTEGER DEFAULT 1,              -- Quox-shipped default (1) vs user-added (0)

    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_model_def_provider ON model_definitions(provider);
CREATE INDEX IF NOT EXISTS idx_model_def_status ON model_definitions(status);
CREATE INDEX IF NOT EXISTS idx_model_def_risk ON model_definitions(risk_tier);

-- ============================================================================
-- DATA CLASS REFERENCE
-- ============================================================================

CREATE TABLE IF NOT EXISTS data_class_definitions (
    id TEXT PRIMARY KEY,                    -- slug: 'pii', 'credentials', 'financial', etc.
    name TEXT NOT NULL,
    description TEXT,
    default_sensitivity TEXT DEFAULT 'confidential'
        CHECK (default_sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
    compliance_frameworks_json TEXT DEFAULT '[]',   -- ['gdpr', 'hipaa']
    sort_order INTEGER DEFAULT 0
);

-- ============================================================================
-- CROSS-CUTTING: ASSET OWNERS
-- ============================================================================

CREATE TABLE IF NOT EXISTS asset_owners (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    asset_type TEXT NOT NULL,               -- 'agent', 'tool', 'workflow', 'model', 'plugin', 'integration'
    asset_id TEXT NOT NULL,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'team', 'system')),
    owner_id TEXT NOT NULL,
    is_primary INTEGER DEFAULT 0,           -- 1 = the accountable owner (1 per asset)
    role TEXT DEFAULT 'owner' CHECK (role IN ('owner', 'steward', 'reviewer')),
    assigned_by TEXT,
    assigned_at TEXT DEFAULT (datetime('now')),
    UNIQUE(asset_type, asset_id, owner_type, owner_id, role)
);

CREATE INDEX IF NOT EXISTS idx_asset_owners_asset ON asset_owners(asset_type, asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_owners_owner ON asset_owners(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_asset_owners_org ON asset_owners(org_id);

-- ============================================================================
-- CROSS-CUTTING: ASSET DATA CLASSES
-- ============================================================================

CREATE TABLE IF NOT EXISTS asset_data_classes (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    data_class TEXT NOT NULL,               -- references data_class_definitions.id
    sensitivity TEXT DEFAULT 'internal'
        CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
    classified_by TEXT,
    classified_at TEXT DEFAULT (datetime('now')),
    UNIQUE(asset_type, asset_id, data_class)
);

CREATE INDEX IF NOT EXISTS idx_asset_data_classes_asset ON asset_data_classes(asset_type, asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_data_classes_class ON asset_data_classes(data_class);

-- ===== END schema-reg.sql =====

-- ===== BEGIN schema-retention.sql =====
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

-- ===== END schema-retention.sql =====

-- ===== BEGIN schema-updates.sql =====
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

-- ===== END schema-updates.sql =====

-- ===== BEGIN migrations/github-mappings.sql =====
-- GitHub Org Mappings — Phase R2
-- Links Quox organisations to GitHub organisations with vault-backed credentials.

CREATE TABLE IF NOT EXISTS github_org_mappings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  github_org_login TEXT NOT NULL,
  github_org_id INTEGER NOT NULL,
  credential_id TEXT,
  tracked_repos TEXT DEFAULT '[]',
  sync_interval INTEGER DEFAULT 15,
  synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, github_org_login)
);

-- ===== END migrations/github-mappings.sql =====

-- ===== BEGIN inline: ET-4 Phase A custom_roles + custom_role_capabilities (db/index.js) =====
CREATE TABLE IF NOT EXISTS custom_roles (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL,
    slug        TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    created_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at  TEXT,
    UNIQUE(org_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_custom_roles_org
    ON custom_roles(org_id, deleted_at);
CREATE TABLE IF NOT EXISTS custom_role_capabilities (
    id         TEXT PRIMARY KEY,
    role_id    TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
    capability TEXT NOT NULL,
    scope_id   TEXT,
    UNIQUE(role_id, capability, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_custom_role_caps_role
    ON custom_role_capabilities(role_id);
-- ===== END inline: ET-4 Phase A =====

-- ===== BEGIN inline: ET-4 Phase C session_policies + ip_allowlist (db/index.js) =====
CREATE TABLE IF NOT EXISTS session_policies (
    org_id              TEXT PRIMARY KEY,
    idle_timeout_sec    INTEGER NOT NULL,
    max_session_sec     INTEGER NOT NULL,
    remember_me_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ip_allowlist (
    id         TEXT PRIMARY KEY,
    org_id     TEXT NOT NULL,
    cidr       TEXT NOT NULL,
    label      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_ip_allowlist_org ON ip_allowlist(org_id);
-- NOTE: orgs.security_flags_json column is added by a numbered migration
-- (was a nested ALTER in this same guarded block in db/index.js) since a
-- bare ALTER cannot live in this idempotent-only baseline file.
-- ===== END inline: ET-4 Phase C =====

-- ===== BEGIN inline: ET-2 Phase A sso_providers + sso_provider_domains + sso_sessions (db/index.js) =====
CREATE TABLE IF NOT EXISTS sso_providers (
    id                   TEXT PRIMARY KEY,
    org_id               TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    protocol             TEXT NOT NULL DEFAULT 'oidc',
    provider_key         TEXT NOT NULL,
    display_name         TEXT,
    issuer               TEXT NOT NULL,
    client_id            TEXT NOT NULL,
    client_secret_cipher TEXT NOT NULL,
    authz_url            TEXT,
    token_url            TEXT,
    userinfo_url         TEXT,
    jwks_uri             TEXT,
    scopes_json          TEXT NOT NULL DEFAULT '[]',
    enabled              INTEGER NOT NULL DEFAULT 1,
    sso_only             INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, provider_key)
);
CREATE INDEX IF NOT EXISTS idx_sso_providers_org ON sso_providers(org_id, enabled);
CREATE TABLE IF NOT EXISTS sso_provider_domains (
    id          TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
    domain      TEXT NOT NULL,
    UNIQUE(provider_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_sso_provider_domains_domain ON sso_provider_domains(domain);
CREATE TABLE IF NOT EXISTS sso_sessions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    provider_id   TEXT NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
    subject       TEXT NOT NULL,
    email         TEXT,
    last_login_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider_id, subject)
);
-- ===== END inline: ET-2 Phase A =====

-- ===== BEGIN inline: ET-2 Phase B sso_auth_states (db/index.js) =====
CREATE TABLE IF NOT EXISTS sso_auth_states (
    id             TEXT PRIMARY KEY,
    provider_id    TEXT NOT NULL,
    state          TEXT NOT NULL UNIQUE,
    code_verifier  TEXT NOT NULL,
    redirect_to    TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sso_auth_states_expires ON sso_auth_states(expires_at_ms);
-- ===== END inline: ET-2 Phase B =====

-- ===== BEGIN inline: ET-3 Phase A verified_domains (db/index.js) =====
CREATE TABLE IF NOT EXISTS verified_domains (
    id                  TEXT PRIMARY KEY,
    org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    domain              TEXT NOT NULL,
    verification_token  TEXT NOT NULL,
    verification_method TEXT,
    verified_at         TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_verified_domains_domain ON verified_domains(domain, verified_at);
-- ===== END inline: ET-3 Phase A =====

-- ===== BEGIN inline: ET-3 Phase B team_events + webhooks + webhook_deliveries (db/index.js) =====
CREATE TABLE IF NOT EXISTS team_events (
    id               TEXT PRIMARY KEY,
    org_id           TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    team_id          TEXT,
    event_type       TEXT NOT NULL,
    actor_id         TEXT,
    subject_user_id  TEXT,
    metadata_json    TEXT NOT NULL DEFAULT '{}',
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_team_events_org_id  ON team_events(org_id, id);
CREATE INDEX IF NOT EXISTS idx_team_events_created ON team_events(created_at);

CREATE TABLE IF NOT EXISTS webhooks (
    id             TEXT PRIMARY KEY,
    org_id         TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    url            TEXT NOT NULL,
    events_json    TEXT NOT NULL DEFAULT '[]',
    secret_cipher  TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    created_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(org_id, enabled);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              TEXT PRIMARY KEY,
    webhook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_id        TEXT NOT NULL,
    status          TEXT NOT NULL,
    response_status INTEGER,
    error_message   TEXT,
    attempt         INTEGER NOT NULL DEFAULT 1,
    next_retry_at   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry   ON webhook_deliveries(status, next_retry_at);
-- ===== END inline: ET-3 Phase B =====

-- ===== BEGIN inline: ET-3 Phase C scim_tokens (db/index.js) =====
CREATE TABLE IF NOT EXISTS scim_tokens (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL UNIQUE,
    label         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    created_by    TEXT,
    last_used_at  TEXT,
    revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_scim_tokens_hash ON scim_tokens(token_hash);
-- ===== END inline: ET-3 Phase C =====

-- ===== BEGIN inline: ET-6A agent_role_permissions + tool_role_permissions (db/index.js) =====
CREATE TABLE IF NOT EXISTS agent_role_permissions (
    id          TEXT PRIMARY KEY,
    role_id     TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
    agent_id    TEXT NOT NULL,
    scope_id    TEXT NOT NULL DEFAULT '',
    allowed     INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(role_id, agent_id, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_role_perms_lookup
    ON agent_role_permissions(role_id, agent_id);
CREATE TABLE IF NOT EXISTS tool_role_permissions (
    id          TEXT PRIMARY KEY,
    role_id     TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
    tool_id     TEXT NOT NULL,
    allowed     INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(role_id, tool_id)
);
CREATE INDEX IF NOT EXISTS idx_tool_role_perms_lookup
    ON tool_role_permissions(role_id, tool_id);
-- ===== END inline: ET-6A =====

-- ===== BEGIN inline: PB-1 llm_routing_policies (db/index.js) =====
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
-- ===== END inline: PB-1 =====

-- ===== BEGIN inline: REG-CORE standard data class seed rows (db/index.js STANDARD_DATA_CLASSES) =====
-- Static reference vocabulary, unchanged across environments — safe to seed
-- unconditionally via INSERT OR IGNORE (matches the original JS array + loop).
INSERT OR IGNORE INTO data_class_definitions
  (id, name, description, default_sensitivity, compliance_frameworks_json, sort_order)
VALUES
  ('pii',            'Personally Identifiable Information', NULL, 'confidential', '["gdpr"]',            10),
  ('credentials',    'Credentials and Secrets',             NULL, 'restricted',   '["soc2","iso27001"]', 20),
  ('financial',      'Financial Data',                      NULL, 'restricted',   '["pci"]',             30),
  ('health',         'Protected Health Information',        NULL, 'restricted',   '["hipaa"]',           40),
  ('source_code',    'Source Code',                         NULL, 'confidential', '[]',                  50),
  ('infrastructure', 'Infrastructure / Operations',         NULL, 'confidential', '[]',                  60),
  ('internal',       'Internal Business Data',              NULL, 'internal',     '[]',                  70),
  ('public',         'Public / Shareable',                  NULL, 'public',       '[]',                  80);
-- ===== END inline: REG-CORE data class seed =====

-- ===== BEGIN inline: ACT-STREAK user_action_streaks (db/index.js) =====
CREATE TABLE IF NOT EXISTS user_action_streaks (
    user_id TEXT NOT NULL REFERENCES users(id),
    org_id TEXT NOT NULL REFERENCES orgs(id),
    current_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    last_completion_date TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, org_id)
);
-- ===== END inline: ACT-STREAK =====

-- ===== BEGIN inline: QuoxVault credential_folders (db/index.js) =====
CREATE TABLE IF NOT EXISTS credential_folders (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES credential_folders(id),
    color TEXT DEFAULT '#6b7280',
    icon TEXT DEFAULT 'folder',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, parent_id, name)
);
-- ===== END inline: QuoxVault credential_folders =====

-- ===== BEGIN inline: QuoxVault agent_credential_assignments (db/index.js) =====
CREATE TABLE IF NOT EXISTS agent_credential_assignments (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    credential_id TEXT NOT NULL REFERENCES integration_credentials(id) ON DELETE CASCADE,
    tool_type TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, agent_id, credential_id, tool_type)
);
CREATE INDEX IF NOT EXISTS idx_agent_cred_assign_lookup ON agent_credential_assignments(org_id, agent_id, tool_type);
-- ===== END inline: QuoxVault agent_credential_assignments =====

-- ===== BEGIN inline: QuoxVault credential_leases (db/index.js) =====
CREATE TABLE IF NOT EXISTS credential_leases (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    credential_id TEXT NOT NULL REFERENCES integration_credentials(id) ON DELETE CASCADE,
    requested_by_agent_id TEXT NOT NULL,
    requested_by_task_id TEXT,
    approved_by TEXT,
    inbox_item_id TEXT,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    granted_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    use_count INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER,
    last_used_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'expired', 'revoked', 'denied', 'cancelled')),
    justification TEXT,
    context_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cred_leases_org ON credential_leases(org_id);
CREATE INDEX IF NOT EXISTS idx_cred_leases_cred ON credential_leases(credential_id);
CREATE INDEX IF NOT EXISTS idx_cred_leases_agent ON credential_leases(requested_by_agent_id);
CREATE INDEX IF NOT EXISTS idx_cred_leases_status ON credential_leases(status);
CREATE INDEX IF NOT EXISTS idx_cred_leases_expires ON credential_leases(expires_at);
-- ===== END inline: QuoxVault credential_leases =====

-- ===== BEGIN inline: STUDY-REV-2/P5.D user_workflow_library (db/index.js) =====
CREATE TABLE IF NOT EXISTS user_workflow_library (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    definition_json TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'mine',
    source_workflow_id TEXT,
    tags TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_uwl_org_user ON user_workflow_library (org_id, user_id);
-- ===== END inline: STUDY-REV-2/P5.D =====

-- ===== BEGIN inline: STUDY-REV-2/P7.E.1 prompts + prompt_versions (db/index.js) =====
CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    body TEXT NOT NULL,
    tags TEXT DEFAULT '[]',
    category TEXT,
    visibility TEXT NOT NULL DEFAULT 'private',
    pack_id TEXT,
    pack_version TEXT,
    variables TEXT DEFAULT '[]',
    deploy_targets TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    created_by TEXT,
    deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_prompts_org_user ON prompts(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_prompts_org_visibility ON prompts(org_id, visibility);

CREATE TABLE IF NOT EXISTS prompt_versions (
    id TEXT PRIMARY KEY,
    prompt_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    body TEXT,
    name TEXT,
    description TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_prompt ON prompt_versions(prompt_id, version);
-- ===== END inline: STUDY-REV-2/P7.E.1 =====

-- ===== BEGIN inline: TOOLSMITH Slice B tool_drafts (db/index.js) =====
CREATE TABLE IF NOT EXISTS tool_drafts (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    draft_files  TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tool_drafts_user ON tool_drafts(user_id);
-- ===== END inline: TOOLSMITH Slice B =====

-- ===== BEGIN inline: QCX-7b widget_usage_monthly (db/index.js, always-run) =====
CREATE TABLE IF NOT EXISTS widget_usage_monthly (
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    conversations INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (widget_id, month)
);
CREATE INDEX IF NOT EXISTS idx_widget_usage_widget ON widget_usage_monthly(widget_id);
-- ===== END inline: QCX-7b =====

-- ===== BEGIN inline: QCX-5f widget_prompt_versions (db/index.js, always-run) =====
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
CREATE INDEX IF NOT EXISTS idx_widget_prompt_versions_widget
    ON widget_prompt_versions(widget_id, version DESC);
-- ===== END inline: QCX-5f =====

-- ===== BEGIN inline: LIFECYCLE-P3-D4 pending_audit_events (db/index.js) =====
CREATE TABLE IF NOT EXISTS pending_audit_events (
    id                  TEXT PRIMARY KEY,
    event_type          TEXT NOT NULL,
    payload_json        TEXT NOT NULL,
    attempts            INTEGER NOT NULL DEFAULT 0,
    last_attempt_at     TEXT,
    next_attempt_at     TEXT NOT NULL DEFAULT (datetime('now')),
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    failure_reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_audit_events_next
    ON pending_audit_events(next_attempt_at)
    WHERE attempts < 10;
-- ===== END inline: LIFECYCLE-P3-D4 =====
