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
