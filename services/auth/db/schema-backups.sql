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
