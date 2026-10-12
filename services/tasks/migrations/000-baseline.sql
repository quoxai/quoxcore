-- 000-baseline.sql — TRUST-GATE Phase 3a
--
-- The CURRENT full schema, wrapped in idempotent CREATE ... IF NOT EXISTS
-- form so a genuinely FRESH database builds cleanly from migrations alone.
-- On an EXISTING database (tables already present, e.g. the live dev db),
-- every statement below is a no-op — nothing is dropped or recreated.
--
-- Body = verbatim db/schema.sql PLUS the three ad-hoc CREATE TABLE blocks
-- that previously lived only in db/index.js (agent_performance,
-- objective_templates, user_ui_prefs) — folded in here because they are
-- already part of the service's current live schema but were never
-- reflected into schema.sql, and because they are simple idempotent
-- creates with no FK/ordering dependency on anything later.
--
-- QuoxCORE Background Task Service Schema
-- SQLite with WAL mode, multi-tenant via org_id

CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  -- Budget constraints
  max_tokens INTEGER DEFAULT 100000,
  max_tool_calls INTEGER DEFAULT 50,
  max_duration_ms INTEGER DEFAULT 600000,
  tokens_used INTEGER DEFAULT 0,
  tool_calls_used INTEGER DEFAULT 0,
  -- Progress
  task_count INTEGER DEFAULT 0,
  tasks_completed INTEGER DEFAULT 0,
  tasks_failed INTEGER DEFAULT 0,
  -- Human-in-the-loop
  require_approval_before_start INTEGER DEFAULT 0,
  checkpoint_after_each_task INTEGER DEFAULT 0,
  -- AEE correlation
  corr_id TEXT,
  -- Agentic Teams (Phase 5 prep)
  team_id TEXT,
  -- STUDY-REV R3: re-observe loop. The post-task evaluator reads
  -- goal_condition; if not met and budget remains, decomposes more tasks.
  goal_condition TEXT,
  iteration_count INTEGER NOT NULL DEFAULT 0,
  max_iterations INTEGER NOT NULL DEFAULT 5,
  goal_evaluation_log TEXT,
  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_objectives_org_user ON objectives(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_objectives_status ON objectives(status);
CREATE INDEX IF NOT EXISTS idx_objectives_created ON objectives(created_at);
CREATE INDEX IF NOT EXISTS idx_objectives_team ON objectives(team_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  agent_id TEXT DEFAULT 'quox',
  prompt TEXT,
  sequence_num INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  retry_after TEXT,
  result TEXT,
  tools_used TEXT,
  tokens_used INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_objective ON tasks(objective_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  task_id TEXT,
  checkpoint_type TEXT NOT NULL DEFAULT 'after_task',
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT,
  description TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_objective ON checkpoints(objective_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_status ON checkpoints(status);

CREATE TABLE IF NOT EXISTS task_logs (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  task_id TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  event TEXT NOT NULL,
  message TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_logs_objective ON task_logs(objective_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);

CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  corr_id TEXT,
  type TEXT NOT NULL,
  intent TEXT NOT NULL,
  from_addr TEXT,
  to_addr TEXT,
  payload TEXT,
  objective_id TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_envelopes_objective ON envelopes(objective_id);
CREATE INDEX IF NOT EXISTS idx_envelopes_corr ON envelopes(corr_id);

-- Agentic Teams (Stream E)
CREATE TABLE IF NOT EXISTS team_definitions (
  id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'core',
  status TEXT NOT NULL DEFAULT 'active',
  installed_by TEXT,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_team_defs_org ON team_definitions(org_id);
CREATE INDEX IF NOT EXISTS idx_team_defs_status ON team_definitions(org_id, status);

CREATE TABLE IF NOT EXISTS team_instances (
  id TEXT PRIMARY KEY,
  team_definition_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  current_objective_id TEXT,
  shared_context_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (team_definition_id, org_id) REFERENCES team_definitions(id, org_id),
  FOREIGN KEY (current_objective_id) REFERENCES objectives(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_team_inst_def ON team_instances(team_definition_id);
CREATE INDEX IF NOT EXISTS idx_team_inst_org ON team_instances(org_id);
CREATE INDEX IF NOT EXISTS idx_team_inst_status ON team_instances(status);

-- Autonomous Workflows (Stream E4)
CREATE TABLE IF NOT EXISTS team_schedules (
  id TEXT PRIMARY KEY,
  team_definition_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'schedule',
  cron_expression TEXT,
  timezone TEXT DEFAULT 'UTC',
  objective_template_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_triggered_at TEXT,
  next_trigger_at TEXT,
  last_objective_id TEXT,
  last_status TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  max_consecutive_failures INTEGER DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_team_sched_team ON team_schedules(team_definition_id);
CREATE INDEX IF NOT EXISTS idx_team_sched_org ON team_schedules(org_id);
CREATE INDEX IF NOT EXISTS idx_team_sched_next ON team_schedules(enabled, next_trigger_at);

-- Agent Autonomy (Phase 7.A)
CREATE TABLE IF NOT EXISTS agent_schedules (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'cron',
  cron_expression TEXT,
  timezone TEXT DEFAULT 'UTC',
  task_template_json TEXT NOT NULL,
  escalation_policy_json TEXT DEFAULT '{}',
  budget_json TEXT DEFAULT '{}',
  enabled INTEGER DEFAULT 1,
  last_triggered_at TEXT,
  next_trigger_at TEXT,
  last_objective_id TEXT,
  last_status TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  max_consecutive_failures INTEGER DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_sched_agent ON agent_schedules(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_sched_org ON agent_schedules(org_id);
CREATE INDEX IF NOT EXISTS idx_agent_sched_next ON agent_schedules(enabled, next_trigger_at);

CREATE TABLE IF NOT EXISTS autonomy_decisions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  schedule_id TEXT,
  objective_id TEXT,
  task_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  context_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_autonomy_dec_org ON autonomy_decisions(org_id);
CREATE INDEX IF NOT EXISTS idx_autonomy_dec_agent ON autonomy_decisions(agent_id);
CREATE INDEX IF NOT EXISTS idx_autonomy_dec_created ON autonomy_decisions(created_at);

-- ═══════════════════════════════════════════════════════════════════════
-- QuoxMind: Execution Intelligence Layer (Stream QM)
-- ═══════════════════════════════════════════════════════════════════════

-- Objective outcomes — structured record of every completed objective
CREATE TABLE IF NOT EXISTS objective_outcomes (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  title TEXT,
  team_id TEXT,
  status TEXT NOT NULL,
  quality_score REAL,
  total_duration_ms INTEGER,
  task_count INTEGER,
  tasks_completed INTEGER,
  tasks_failed INTEGER,
  tasks_skipped INTEGER,
  failure_summary TEXT,
  success_summary TEXT,
  pattern_signals TEXT,
  wisdom_ids TEXT,
  post_mortem TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_outcomes_org ON objective_outcomes(org_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_obj ON objective_outcomes(objective_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_created ON objective_outcomes(created_at);

-- Execution wisdom — distilled patterns that compound over time
CREATE TABLE IF NOT EXISTS execution_wisdom (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  pattern_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'execution',
  lesson TEXT NOT NULL,
  decomposition_directive TEXT,
  severity TEXT DEFAULT 'medium',
  confidence REAL DEFAULT 0.5,
  occurrence_count INTEGER DEFAULT 1,
  first_seen_at TEXT,
  last_seen_at TEXT,
  source_objective_ids TEXT,
  tags TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wisdom_org ON execution_wisdom(org_id);
CREATE INDEX IF NOT EXISTS idx_wisdom_pattern ON execution_wisdom(pattern_name);
CREATE INDEX IF NOT EXISTS idx_wisdom_active ON execution_wisdom(active, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_wisdom_category ON execution_wisdom(category);

-- ═══════════════════════════════════════════════════════════════════════
-- Stream QMH (QuoxMind Honest) — implant signal store
-- Generic per-implant observation/event store. Replaces in-memory buffers
-- so signals survive server restart and are queryable across implants.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS implant_signals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  implant_id TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_implant_signals_lookup
  ON implant_signals(org_id, implant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_implant_signals_type
  ON implant_signals(implant_id, signal_type, created_at DESC);

-- QuoxDream consolidation cycle history. Replaces in-memory cycleCount.
-- Each runDreamCycle() invocation writes one row. computeDreamStats reads.
CREATE TABLE IF NOT EXISTS dream_cycles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  cycle_number INTEGER,
  journals_processed INTEGER,
  patterns_found INTEGER,
  wisdom_created INTEGER,
  duration_ms INTEGER,
  skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_dream_cycles_org
  ON dream_cycles(org_id, completed_at DESC);

-- ═══════════════════════════════════════════════════════════════════════
-- Stream QMH-3 — server-side Working Set Memory (WSM)
-- Replaces the browser-only WSM (workingSetMemory.js localStorage) for the
-- QuoxFocus signal path. The browser version was the reason QuoxFocus showed
-- "0 open loops" forever — its data source vanished on every page reload AND
-- was license-blocked at workingSetMemory.js:439-442 anyway.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wsm_focus (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task TEXT,
  project TEXT,
  goal TEXT,
  started_at TEXT,
  context_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS wsm_open_loops (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT DEFAULT 'medium',
  related_project TEXT,
  context_json TEXT,
  trigger_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_touched_at TEXT NOT NULL DEFAULT (datetime('now')),
  due_by TEXT,
  resolved_at TEXT,
  resolution_outcome TEXT
);

CREATE INDEX IF NOT EXISTS idx_wsm_loops_lookup
  ON wsm_open_loops(org_id, user_id, status, last_touched_at DESC);

CREATE TABLE IF NOT EXISTS wsm_recent_entities (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  name TEXT,
  last_mentioned_at TEXT NOT NULL DEFAULT (datetime('now')),
  mention_count INTEGER NOT NULL DEFAULT 1,
  context_json TEXT,
  PRIMARY KEY (org_id, user_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_wsm_entities_lookup
  ON wsm_recent_entities(org_id, user_id, last_mentioned_at DESC);

-- ═══════════════════════════════════════════════════════════════════════
-- Folded from ad-hoc db/index.js blocks (never previously in schema.sql)
-- ═══════════════════════════════════════════════════════════════════════

-- AT-3: Agent performance tracking table
CREATE TABLE IF NOT EXISTS agent_performance (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  success INTEGER NOT NULL,
  quality_score INTEGER DEFAULT 50,
  latency_ms INTEGER,
  tokens_used INTEGER,
  domain TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_perf_lookup ON agent_performance(org_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_perf_domain ON agent_performance(org_id, agent_id, domain);

-- OE-7: Objective templates table
CREATE TABLE IF NOT EXISTS objective_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_objective_id TEXT,
  template_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- P6.B: User UI preferences — general key-value store for server-side pref
-- persistence. Replaces localStorage usage for template var history and
-- PRISM collapse state.
CREATE TABLE IF NOT EXISTS user_ui_prefs (
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  pref_key TEXT NOT NULL,
  pref_value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, org_id, pref_key)
);
