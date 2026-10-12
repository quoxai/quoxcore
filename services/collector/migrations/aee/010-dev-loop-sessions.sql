-- 010-dev-loop-sessions.sql — DEVSUITE-DEVMODE fleet spawn seam (collector
-- half; design in QuoxPlan DEVSUITE-DEVMODE note #2665).
--
-- dev_loop_sessions: one row per spawned structured-mode loop session. The
-- collector mints the session id and a per-session ingest token at spawn
-- time; only the token's sha256 is stored (a leaked table never yields a
-- forgeable credential).
--
-- dev_loop_session_events: the durable event stream a quoxagent host's
-- EventForwarder pushes outbound. (session_id, seq) PRIMARY KEY makes
-- ingest idempotent (INSERT OR IGNORE) under the forwarder's
-- at-least-once retry, and gives the tasks service's since_seq poll an
-- index-ordered resumable read.

CREATE TABLE IF NOT EXISTS dev_loop_sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  agent_session_id TEXT,
  backend TEXT NOT NULL,
  ingest_token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'spawned',
  created_at TEXT NOT NULL,
  done_at TEXT
);

CREATE TABLE IF NOT EXISTS dev_loop_session_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT,
  raw TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
