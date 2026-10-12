-- 035-agent-standing.sql — Agent Standing
--
-- Per (org_id, agent_id, task_class) trust score, sitting below the
-- per-decision Autonomy Decision framework (autonomyDecision.js's
-- makeDecision()). Where makeDecision() gates a single decision on
-- budget/tool-risk/failure-history, Standing gates on an agent's
-- TRACK RECORD in a given task class: corrections/overrides/rollbacks
-- push the score down (an immediate, dated drop event), a score below
-- SUPERVISED_THRESHOLD (40, see agentStanding.js) flips status to
-- 'supervised' (forces ESCALATE regardless of the per-decision checks),
-- and 3 consecutive clean supervised runs at >= the risk tier that
-- triggered the drop earn redemption back to 'autonomous'.
--
-- task_class = agent_performance.domain (see agentScorer.js) — the same
-- per-task domain tag the AT-3 learning router scores agents on.
--
-- agent_standing.id is a surrogate ULID PK; the natural/business key is
-- the UNIQUE(org_id, agent_id, task_class) triple. agent_standing_events
-- is append-only and mirrors autonomy_decisions' shape (see
-- 000-baseline.sql CREATE TABLE autonomy_decisions).

CREATE TABLE IF NOT EXISTS agent_standing (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_class TEXT NOT NULL,
  standing_score REAL NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'autonomous'
    CHECK (status IN ('autonomous', 'supervised')),
  consecutive_clean_supervised INTEGER NOT NULL DEFAULT 0,
  last_change_at TEXT,
  last_change_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, agent_id, task_class)
);

CREATE INDEX IF NOT EXISTS idx_agent_standing_org ON agent_standing(org_id);
CREATE INDEX IF NOT EXISTS idx_agent_standing_agent ON agent_standing(org_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_standing_status ON agent_standing(org_id, status);

-- Append-only event log. Never UPDATEd/DELETEd — agent_standing is the
-- current-state projection, this table is the audit trail behind it.
CREATE TABLE IF NOT EXISTS agent_standing_events (
  id TEXT PRIMARY KEY,
  standing_id TEXT NOT NULL REFERENCES agent_standing(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_class TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('clean_completion', 'correction', 'rollback', 'override', 'redemption_run')),
  delta REAL,
  task_id TEXT,
  objective_id TEXT,
  actor TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_standing_events_standing ON agent_standing_events(standing_id);
CREATE INDEX IF NOT EXISTS idx_agent_standing_events_org ON agent_standing_events(org_id);
CREATE INDEX IF NOT EXISTS idx_agent_standing_events_agent ON agent_standing_events(org_id, agent_id, task_class);
CREATE INDEX IF NOT EXISTS idx_agent_standing_events_created ON agent_standing_events(created_at);
