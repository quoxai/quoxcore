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
-- REPOBRAIN CONNECTIONS (QN Phase 1: per-org RepoBrain backend registry)
-- ============================================================================
-- Mirrors github_org_mappings above: the row holds NO secret. credential_id
-- references integration_credentials, where the backend's shared secret is
-- stored as a v2 envelope. See migrations/083-repobrain-connections.sql for
-- the migration-runner copy of this DDL (fresh installs build from this
-- file; already-migrated installs pick it up via the numbered migration).

CREATE TABLE IF NOT EXISTS repobrain_connections (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    label TEXT NOT NULL,                    -- "On-prem build box", "Bundled"
    base_url TEXT NOT NULL,                 -- e.g. http://192.0.2.127:3105
    credential_id TEXT REFERENCES integration_credentials(id) ON DELETE SET NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, label)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_repobrain_default_per_org
    ON repobrain_connections(org_id) WHERE is_default = 1;

CREATE INDEX IF NOT EXISTS idx_repobrain_connections_org
    ON repobrain_connections(org_id);

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
