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
