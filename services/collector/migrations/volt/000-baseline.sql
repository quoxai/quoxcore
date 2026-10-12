-- 000-baseline.sql — collector VOLT database (volt.db)
--
-- The CURRENT full schema for volt.db (verbatim copy of the inline CREATE
-- statements previously executed directly in server.js, plus the schemas
-- owned by lib modules that are always initialised against voltDb at boot:
-- lib/policyStore.js, lib/policyHistory.js, lib/governanceIncidents.js,
-- lib/governanceWebhookConfig.js, lib/agentBehaviorService.js,
-- lib/pdf/pdfCache.js, lib/chainGuards/promiseStore.js,
-- lib/chainGuards/crossOrgTrustRootsStore.js), wrapped in idempotent
-- CREATE ... IF NOT EXISTS form so a genuinely FRESH database builds cleanly
-- from migrations alone. On an EXISTING database (tables already present,
-- e.g. the live dev db), every statement below is a no-op — nothing is
-- dropped or recreated.
--
-- Despite the "VOLT" name (VOLT_DB_PATH), this is the collector's
-- general-purpose secondary DB — it holds VOLT execution traces AND
-- governance policies/incidents/webhooks/behaviour baselines AND compliance
-- assessments AND plugin storage AND trust chain state. It is the largest
-- and highest-value store in the service.
--
-- NOTE: the lib modules above continue to call their own init*(voltDb)
-- functions at boot (unchanged by this migration) — those calls are now
-- redundant idempotent no-ops against an already-migrated DB, which is safe
-- and intentionally left in place to avoid touching those files' behaviour
-- outside this task's scope.

-- ── VOLT execution traces ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS volt_runs (
  run_id TEXT PRIMARY KEY,
  corr TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  seq INTEGER DEFAULT 0,
  head_hash TEXT,
  stored_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_volt_runs_corr ON volt_runs(corr);
CREATE INDEX IF NOT EXISTS idx_volt_runs_status ON volt_runs(status);

CREATE TABLE IF NOT EXISTS volt_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_type TEXT,
  ts TEXT,
  seq INTEGER,
  data TEXT,
  stored_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_volt_events_run ON volt_events(run_id);
CREATE INDEX IF NOT EXISTS idx_volt_events_type ON volt_events(event_type);

CREATE TABLE IF NOT EXISTS volt_bundles (
  bundle_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  created_ts TEXT,
  data TEXT,
  stored_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_volt_bundles_run ON volt_bundles(run_id);

CREATE TABLE IF NOT EXISTS volt_content (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_type TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  content TEXT,
  content_hash TEXT,
  redacted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_volt_content_run ON volt_content(run_id);

-- CRP-BE-5: Compliance scheduled jobs and report storage
CREATE TABLE IF NOT EXISTS compliance_jobs (
  id TEXT PRIMARY KEY,
  format TEXT NOT NULL,
  schedule_interval TEXT NOT NULL,
  schedule_day_of_week INTEGER,
  schedule_day_of_month INTEGER,
  options TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_run TEXT,
  next_run TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS compliance_reports (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  format TEXT NOT NULL,
  generated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  period_start TEXT,
  period_end TEXT,
  period_days INTEGER,
  summary TEXT,
  report_data TEXT,
  status TEXT DEFAULT 'completed'
);
CREATE INDEX IF NOT EXISTS idx_compliance_reports_format ON compliance_reports(format);
CREATE INDEX IF NOT EXISTS idx_compliance_reports_date ON compliance_reports(generated_at);

-- AUD-UX-1: SoA (Statement of Applicability) assessments
CREATE TABLE IF NOT EXISTS soa_assessments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT '',
  framework TEXT NOT NULL DEFAULT 'iso27001_2022',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'review', 'approved')),
  controls_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_soa_org ON soa_assessments(org_id);

-- AUD-UX-2: Risk classification assessments
CREATE TABLE IF NOT EXISTS risk_classifications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT '',
  system_name TEXT NOT NULL DEFAULT '',
  answers_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  memo TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'complete')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_risk_class_org ON risk_classifications(org_id);

-- AUD-UX-3: DPIA assessments
CREATE TABLE IF NOT EXISTS dpia_assessments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT '',
  processing_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'dpo_review', 'approved', 'prior_consultation_required')),
  version INTEGER NOT NULL DEFAULT 1,
  sections_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dpia_org ON dpia_assessments(org_id);

-- AUD-UX-6: Auditor engagements
CREATE TABLE IF NOT EXISTS auditor_engagements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT '',
  auditor_email TEXT NOT NULL DEFAULT '',
  auditor_name TEXT NOT NULL DEFAULT '',
  firm_name TEXT NOT NULL DEFAULT '',
  framework TEXT NOT NULL DEFAULT '',
  period_start TEXT,
  period_end TEXT,
  duration_days INTEGER NOT NULL DEFAULT 90,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'completed', 'archived')),
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eng_org ON auditor_engagements(org_id);
CREATE INDEX IF NOT EXISTS idx_eng_email ON auditor_engagements(auditor_email);

-- TRV-1: Trace replay sessions, comparisons, and correlation cache
CREATE TABLE IF NOT EXISTS replay_sessions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  query TEXT,
  layer_config TEXT,
  mock_config TEXT,
  original_trace TEXT,
  replay_result TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  org_id TEXT,
  user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_replay_sessions_run ON replay_sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_replay_sessions_org ON replay_sessions(org_id);

CREATE TABLE IF NOT EXISTS trace_comparisons (
  id TEXT PRIMARY KEY,
  name TEXT,
  corr_ids TEXT NOT NULL,
  options TEXT,
  result TEXT,
  similarity_score REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  org_id TEXT,
  user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_trace_comparisons_org ON trace_comparisons(org_id);

CREATE TABLE IF NOT EXISTS trace_correlations (
  id TEXT PRIMARY KEY,
  root_run_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  tree TEXT NOT NULL,
  stats TEXT,
  agent_count INTEGER DEFAULT 0,
  handoff_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  org_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_trace_correlations_root ON trace_correlations(root_run_id);
CREATE INDEX IF NOT EXISTS idx_trace_correlations_corr ON trace_correlations(correlation_id);

-- PSDK-5: Plugin Storage — server-side key-value store per plugin per org
CREATE TABLE IF NOT EXISTS plugin_storage (
  plugin_id TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT 'default',
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (plugin_id, org_id, key)
);

-- VOLT Certification — Trust seal API (Phase 5.B)
CREATE TABLE IF NOT EXISTS volt_certifications (
  cert_id TEXT PRIMARY KEY,
  run_id TEXT,
  bundle_id TEXT,
  tier TEXT NOT NULL,
  tier_name TEXT NOT NULL,
  checks TEXT NOT NULL,
  summary TEXT NOT NULL,
  certified_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT,
  stored_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_volt_certs_run ON volt_certifications(run_id);
CREATE INDEX IF NOT EXISTS idx_volt_certs_tier ON volt_certifications(tier);
CREATE INDEX IF NOT EXISTS idx_volt_certs_expires ON volt_certifications(expires_at);

-- ── GOV-1: Unified Policy Store (lib/policyStore.js) ────────────────────────
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  scope TEXT NOT NULL DEFAULT '{}',
  conditions TEXT NOT NULL DEFAULT '{}',
  effect TEXT NOT NULL DEFAULT 'deny',
  reason TEXT DEFAULT '',
  framework_mapping TEXT DEFAULT '[]',
  audit_required INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  org_id TEXT NOT NULL,
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(name, org_id)
);
CREATE INDEX IF NOT EXISTS idx_policies_org ON policies(org_id);
CREATE INDEX IF NOT EXISTS idx_policies_category ON policies(category);
CREATE INDEX IF NOT EXISTS idx_policies_enabled ON policies(enabled);

-- POL-HIST: change-log + 4-eyes approval (lib/policyHistory.js)
CREATE TABLE IF NOT EXISTS policy_history (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  version_before INTEGER,
  version_after INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  diff_json TEXT,
  actor_id TEXT NOT NULL DEFAULT 'unknown',
  actor_email TEXT,
  actor_label TEXT NOT NULL DEFAULT 'unknown',
  actor_source TEXT NOT NULL DEFAULT 'api',
  reason TEXT,
  request_id TEXT,
  approval_state TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_phist_policy ON policy_history(policy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phist_org ON policy_history(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phist_operation ON policy_history(operation);
CREATE INDEX IF NOT EXISTS idx_phist_approval ON policy_history(approval_state)
  WHERE approval_state = 'pending';

-- MON-GOV: Runtime governance incident store (lib/governanceIncidents.js)
CREATE TABLE IF NOT EXISTS governance_incidents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  incident_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  layer TEXT,
  policy_id TEXT,
  policy_name TEXT,
  framework_mapping TEXT NOT NULL DEFAULT '[]',
  corr TEXT NOT NULL,
  envelope_ids TEXT NOT NULL DEFAULT '[]',
  agent_id TEXT,
  user_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  context_json TEXT,
  assigned_to TEXT,
  resolution TEXT,
  resolved_at TEXT,
  escalated INTEGER NOT NULL DEFAULT 0,
  witnessed_by_ward INTEGER NOT NULL DEFAULT 0,
  witness_receipt TEXT,
  dedup_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_dedup ON governance_incidents(dedup_key);
CREATE INDEX IF NOT EXISTS idx_incidents_org_status ON governance_incidents(org_id, status);
CREATE INDEX IF NOT EXISTS idx_incidents_corr ON governance_incidents(corr);
CREATE INDEX IF NOT EXISTS idx_incidents_created ON governance_incidents(created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON governance_incidents(severity);

-- MON-GOV-3: SIEM outbound — webhook config store (lib/governanceWebhookConfig.js)
CREATE TABLE IF NOT EXISTS governance_webhook_config (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  target_url TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'generic_json',
  auth_scheme TEXT NOT NULL DEFAULT 'none',
  auth_secret TEXT,
  event_type_filter TEXT,
  min_severity TEXT NOT NULL DEFAULT 'medium',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_delivery_at TEXT,
  last_status INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_webhook_org ON governance_webhook_config(org_id);
CREATE INDEX IF NOT EXISTS idx_webhook_enabled ON governance_webhook_config(enabled);

-- MON-GOV-4: Behavioural baselines + anomaly detection (lib/agentBehaviorService.js)
CREATE TABLE IF NOT EXISTS agent_behavior_baselines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  baseline_value REAL NOT NULL,
  stddev REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, agent_id, metric)
);
CREATE INDEX IF NOT EXISTS idx_baseline_agent ON agent_behavior_baselines(agent_id, metric);
CREATE INDEX IF NOT EXISTS idx_baseline_org ON agent_behavior_baselines(org_id);

-- AUD-PDF: generated-PDF cache (lib/pdf/pdfCache.js)
CREATE TABLE IF NOT EXISTS pdf_exports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  format TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  pdf_bytes BLOB NOT NULL,
  bytes_length INTEGER NOT NULL,
  page_count INTEGER,
  redacted INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_cache_key ON pdf_exports(org_id, cache_key);
CREATE INDEX IF NOT EXISTS idx_pdf_org_time ON pdf_exports(org_id, generated_at DESC);

-- Chain guards: promise tracking (lib/chainGuards/promiseStore.js)
CREATE TABLE IF NOT EXISTS chain_promises (
  promise_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT,
  agent_id TEXT,
  turn_id TEXT,
  promise_text TEXT NOT NULL,
  inferred_skill TEXT,
  inferred_target TEXT,
  inferred_when TEXT,
  language TEXT NOT NULL CHECK (language IN ('en','es')),
  created_at INTEGER NOT NULL,
  due_at INTEGER,
  fulfilled INTEGER,
  fulfilled_envelope_id TEXT,
  fulfilled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chain_promises_conv ON chain_promises(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chain_promises_org ON chain_promises(org_id);

-- Chain guards: cross-org trust roots (lib/chainGuards/crossOrgTrustRootsStore.js)
CREATE TABLE IF NOT EXISTS cross_org_trust_roots (
  row_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  counterparty_org_id TEXT NOT NULL,
  counterparty_name TEXT NOT NULL,
  pubkey TEXT,
  added_at INTEGER NOT NULL,
  removed_at INTEGER,
  UNIQUE (org_id, counterparty_org_id)
);
CREATE INDEX IF NOT EXISTS idx_trust_roots_org ON cross_org_trust_roots(org_id);
CREATE INDEX IF NOT EXISTS idx_trust_roots_name ON cross_org_trust_roots(org_id, counterparty_name);
