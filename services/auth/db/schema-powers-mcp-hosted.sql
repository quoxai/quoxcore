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
