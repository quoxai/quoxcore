-- 083-repobrain-connections.sql
-- QUOX-REPOBRAIN Phase 1: per-org RepoBrain (QuoxNucleus) backend registry.
--
-- Mirrors github_org_mappings: the row holds NO secret. credential_id
-- references integration_credentials (QuoxVault), where the backend's
-- shared secret is stored as a v2 envelope. ON DELETE SET NULL (not
-- CASCADE): deleting the Vault credential degrades the connection to
-- secretless rather than silently deleting the registration, matching the
-- github mapping LEFT JOIN semantics.
--
-- No status/test_status column: test state lives on the credential row
-- (integration_credentials.test_status) exactly as github mappings surface
-- it.
CREATE TABLE IF NOT EXISTS repobrain_connections (
  id TEXT PRIMARY KEY,                    -- ULID via generateId()
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  label TEXT NOT NULL,                    -- "On-prem build box", "Bundled"
  base_url TEXT NOT NULL,                 -- e.g. http://192.0.2.127:3105
  credential_id TEXT REFERENCES integration_credentials(id) ON DELETE SET NULL,
                                          -- nullable: an open localhost backend
                                          -- may legitimately have no secret
  is_default INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, label)
);

-- At most one default per org, enforced in the schema, not just app code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_repobrain_default_per_org
  ON repobrain_connections(org_id) WHERE is_default = 1;

CREATE INDEX IF NOT EXISTS idx_repobrain_connections_org
  ON repobrain_connections(org_id);
