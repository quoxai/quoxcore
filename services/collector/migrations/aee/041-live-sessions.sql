-- 041-live-sessions.sql — DEVSUITE phase 19: org-scoped register of live
-- working sessions (Claude/Codex in tmux on dev hosts). Hosts report their
-- full session list; rows missing from a host's report are deleted.

CREATE TABLE IF NOT EXISTS live_sessions (
  org_id TEXT NOT NULL,
  host TEXT NOT NULL,
  name TEXT NOT NULL,
  program TEXT,
  tmux INTEGER NOT NULL DEFAULT 0,
  attached INTEGER NOT NULL DEFAULT 0,
  slot TEXT,
  agent TEXT,
  splinter TEXT,
  stream TEXT,
  pid INTEGER,
  started_at TEXT,
  last_seen_at TEXT NOT NULL,
  meta TEXT,
  PRIMARY KEY (org_id, host, name)
);

CREATE INDEX IF NOT EXISTS idx_live_sessions_org_seen ON live_sessions(org_id, last_seen_at);
