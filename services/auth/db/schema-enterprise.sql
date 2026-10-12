-- Quox Auth Service Database Schema
-- Enterprise Extension Schema
-- Adds: capability_grants, artifacts, team scope attachment, agent soft delete
-- ============================================================================
--
-- MIGRATION: Run this after all other schema files (schema.sql, schema-b1.sql,
-- schema-b2-tools.sql, schema-c1.sql)
--
-- This schema adds:
-- - capability_grants: Fine-grained permission system for RBAC++
-- - artifacts: Store outputs from workflow/agent runs
-- - teams.attach_scope_id: Link teams to scope hierarchy
-- - agents.retired_at: Soft delete support for agents
-- - tools/workflows: risk_flags_json, forked_from_id columns
-- ============================================================================

-- ============================================================================
-- TEAM SCOPE ATTACHMENT
-- ============================================================================

-- Add attach_scope_id to teams for scope hierarchy integration
-- This allows a team to be "attached" to a specific scope in the org hierarchy
-- e.g., Team "DevOps" attached to Division "Engineering"
ALTER TABLE teams ADD COLUMN attach_scope_id TEXT REFERENCES scopes(id);

CREATE INDEX IF NOT EXISTS idx_teams_attach_scope ON teams(attach_scope_id);

-- ============================================================================
-- CAPABILITY GRANTS (Fine-Grained RBAC++)
-- ============================================================================

-- Grants specific capabilities to principals (users, teams, service accounts)
-- This supplements role-based access with fine-grained permissions
-- Supports both positive grants and scope-restricted grants
CREATE TABLE IF NOT EXISTS capability_grants (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

    -- Principal receiving the grant
    principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'team', 'service_account')),
    principal_id TEXT NOT NULL,

    -- The capability being granted
    -- Format: domain.action (e.g., 'agents.create', 'tools.assign', 'secrets.read')
    capability TEXT NOT NULL,

    -- Scope restriction (optional - limits where this capability applies)
    scope_id TEXT REFERENCES scopes(id),    -- null = org-wide

    -- Grant metadata
    granted_by TEXT REFERENCES users(id),
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,                        -- Optional expiration
    revoked_at TEXT,
    revoked_by TEXT REFERENCES users(id),

    -- Audit metadata
    reason TEXT,                            -- Why was this granted?

    UNIQUE(org_id, principal_type, principal_id, capability, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_capability_grants_org ON capability_grants(org_id);
CREATE INDEX IF NOT EXISTS idx_capability_grants_principal ON capability_grants(org_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS idx_capability_grants_capability ON capability_grants(org_id, capability);
CREATE INDEX IF NOT EXISTS idx_capability_grants_scope ON capability_grants(scope_id);
CREATE INDEX IF NOT EXISTS idx_capability_grants_active ON capability_grants(org_id, principal_type, principal_id, revoked_at);

-- ============================================================================
-- ARTIFACTS (Run Outputs)
-- ============================================================================

-- Artifacts are files or data produced by workflow/agent runs
-- Stored references to actual content (in object storage or filesystem)
CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,                    -- ULID
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

    -- Identity
    name TEXT NOT NULL,                     -- Display name
    artifact_type TEXT NOT NULL DEFAULT 'file'
        CHECK (artifact_type IN ('file', 'log', 'report', 'snapshot', 'export', 'other')),

    -- Content metadata
    content_type TEXT,                      -- MIME type (e.g., 'application/json')
    encoding TEXT DEFAULT 'utf-8',          -- Character encoding if applicable
    size_bytes INTEGER,
    checksum TEXT,                          -- SHA256 of content

    -- Storage location
    storage_type TEXT NOT NULL DEFAULT 'filesystem'
        CHECK (storage_type IN ('filesystem', 's3', 'inline')),
    storage_path TEXT,                      -- Path or key in storage system
    storage_bucket TEXT,                    -- S3 bucket if applicable
    inline_content TEXT,                    -- For small artifacts stored inline

    -- Metadata
    metadata_json TEXT DEFAULT '{}',        -- Additional artifact-specific metadata
    labels_json TEXT DEFAULT '[]',          -- Tags/labels for filtering

    -- Lifecycle
    expires_at TEXT,                        -- Auto-cleanup time
    preserved INTEGER NOT NULL DEFAULT 0,   -- If 1, skip auto-cleanup

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_org ON artifacts(org_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(artifact_type);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_expires ON artifacts(expires_at);

-- ============================================================================
-- AGENT SOFT DELETE
-- ============================================================================

-- Add retired_at column to agents for soft delete support
-- Retired agents are kept for audit trail but no longer active
ALTER TABLE agents ADD COLUMN retired_at TEXT;
ALTER TABLE agents ADD COLUMN retired_by TEXT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_agents_retired ON agents(org_id, retired_at);
CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(org_id, status, retired_at);

-- ============================================================================
-- TOOL FORKING AND RISK FLAGS
-- ============================================================================

-- Add risk flags to tools for security classification
-- risk_flags_json contains array of risk categories
-- e.g., ["network_access", "file_write", "credential_access"]
-- Note: If column already exists, ALTER TABLE will fail silently in some SQLite versions

-- For tool_definitions (catalog)
-- These columns may need to be added via PRAGMA or application logic if they don't exist

-- For tool_installations (org-level)
-- Add forked_from for tracking tool customizations
-- When an org customizes a tool, the original is preserved

-- ============================================================================
-- WORKFLOW FORKING AND RISK FLAGS
-- ============================================================================

-- Add forked_from_id to workflows for tracking workflow derivation
-- When a user "clones" or "forks" a workflow template
ALTER TABLE workflows ADD COLUMN forked_from_id TEXT REFERENCES workflows(id);

-- Add risk flags to workflows for automated security classification
ALTER TABLE workflows ADD COLUMN risk_flags_json TEXT DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_workflows_forked_from ON workflows(forked_from_id);

-- ============================================================================
-- AGENT-TOOL ASSIGNMENT ENHANCEMENTS
-- ============================================================================

-- Add agent_db_id FK to agent_tool_assignments for proper foreign key
-- This allows joins to the agents table by database ID, not just manifest ID
ALTER TABLE agent_tool_assignments ADD COLUMN agent_db_id TEXT REFERENCES agents(id);

CREATE INDEX IF NOT EXISTS idx_agent_assign_agent_db ON agent_tool_assignments(agent_db_id);

-- ============================================================================
-- AOCL LAYER TRACKING (Agent Orchestration Control Layers)
-- ============================================================================

-- Track which AOCL layers an audit event passed through
-- This provides the 11-layer audit trail for enterprise compliance
-- Layers: L0 (Physical) through L10 (Provenance)
ALTER TABLE audit_events ADD COLUMN aocl_layers_json TEXT DEFAULT '[]';

-- Add correlation ID for AEE envelope tracking
ALTER TABLE audit_events ADD COLUMN correlation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_events(correlation_id);

-- ============================================================================
-- VIEWS FOR ENTERPRISE REPORTING
-- ============================================================================

-- Active capability grants view
CREATE VIEW IF NOT EXISTS active_capability_grants AS
SELECT
    cg.*,
    CASE cg.principal_type
        WHEN 'user' THEN u.display_name
        WHEN 'team' THEN t.name
        ELSE 'Service: ' || cg.principal_id
    END as principal_name,
    s.path as scope_path
FROM capability_grants cg
LEFT JOIN users u ON cg.principal_type = 'user' AND cg.principal_id = u.id
LEFT JOIN teams t ON cg.principal_type = 'team' AND cg.principal_id = t.id
LEFT JOIN scopes s ON cg.scope_id = s.id
WHERE cg.revoked_at IS NULL
  AND (cg.expires_at IS NULL OR cg.expires_at > datetime('now'));

-- Agent status overview
CREATE VIEW IF NOT EXISTS agent_status_overview AS
SELECT
    a.id,
    a.org_id,
    a.agent_id,
    a.name,
    a.level,
    a.status,
    a.retired_at IS NOT NULL as is_retired,
    COUNT(DISTINCT ata.id) as tool_count,
    COUNT(DISTINCT aar.id) as routing_count,
    a.created_at,
    a.updated_at
FROM agents a
LEFT JOIN agent_tool_assignments ata ON ata.agent_db_id = a.id
    AND ata.revoked_at IS NULL
    AND ata.enabled = 1
LEFT JOIN assistant_agent_routing aar ON aar.agent_db_id = a.id
    AND aar.enabled = 1
WHERE a.retired_at IS NULL
GROUP BY a.id;

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- Standard capability definitions (for reference/autocomplete)
INSERT OR IGNORE INTO tool_categories (id, name, description, icon, sort_order) VALUES
    ('enterprise', 'Enterprise', 'Enterprise administration and governance', '🏢', 0);

-- Note: Run this migration with care. Some ALTER TABLE statements may fail
-- if columns already exist. SQLite doesn't support IF NOT EXISTS for ALTER TABLE.
-- Application code should handle these gracefully.
