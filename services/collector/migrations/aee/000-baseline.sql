-- 000-baseline.sql — collector AEE database (aee.db)
--
-- The CURRENT full schema for aee.db (verbatim copy of the inline CREATE
-- statements previously executed directly in server.js / lib/nocOutcomeRecorder.js
-- / lib/suggestionDismissals.js at boot), wrapped in idempotent
-- CREATE ... IF NOT EXISTS form so a genuinely FRESH database builds cleanly
-- from migrations alone. On an EXISTING database (tables already present,
-- e.g. the live dev db), every statement below is a no-op — nothing is
-- dropped or recreated.

-- AEE (Agent Envelope Exchange) audit trail — the collector's primary
-- fire-and-forget envelope log.
CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  intent TEXT NOT NULL,
  corr TEXT NOT NULL,
  reply_to TEXT,
  payload TEXT NOT NULL,
  raw TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_corr ON envelopes(corr);
CREATE INDEX IF NOT EXISTS idx_ts ON envelopes(ts);
CREATE INDEX IF NOT EXISTS idx_type ON envelopes(type);
CREATE INDEX IF NOT EXISTS idx_intent ON envelopes(intent);
CREATE INDEX IF NOT EXISTS idx_from ON envelopes("from");
CREATE INDEX IF NOT EXISTS idx_to ON envelopes("to");
CREATE INDEX IF NOT EXISTS idx_reply_to ON envelopes(reply_to);

-- NQ-5: NOC tool execution outcomes (lib/nocOutcomeRecorder.js, shares aeeDb)
CREATE TABLE IF NOT EXISTS noc_tool_outcomes (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  tool_name TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER DEFAULT 0,
  error TEXT,
  agent_id TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_noc_outcomes_tool ON noc_tool_outcomes(tool_name);
CREATE INDEX IF NOT EXISTS idx_noc_outcomes_org ON noc_tool_outcomes(org_id);
CREATE INDEX IF NOT EXISTS idx_noc_outcomes_created ON noc_tool_outcomes(created_at);

-- P10.I-3: Quox Brain suggestion dismissals (lib/suggestionDismissals.js,
-- shares aeeDb — see mountSuggestionsRoutes(app, aeeDb, ...) in server.js)
CREATE TABLE IF NOT EXISTS suggestion_dismissals (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  user_id       TEXT NOT NULL DEFAULT '',
  suggestion_id TEXT NOT NULL,
  dismissed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  UNIQUE(org_id, suggestion_id)
);
CREATE INDEX IF NOT EXISTS idx_sd_org ON suggestion_dismissals(org_id);
CREATE INDEX IF NOT EXISTS idx_sd_expires ON suggestion_dismissals(expires_at);
