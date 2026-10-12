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
