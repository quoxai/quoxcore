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
