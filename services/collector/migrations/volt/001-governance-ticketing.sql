-- MON-GOV-INT Phase 1: Governance incident → ticketing (Jira first).
-- Mirrors the MON-GOV-3 SIEM webhook config/dispatcher pattern one seam
-- over: config is per-org routing (vault credential_id ref, no inline
-- secrets), governance_incident_tickets is the per-(incident, config)
-- delivery record with a dedup UNIQUE index.

CREATE TABLE IF NOT EXISTS governance_ticket_config (
  id TEXT PRIMARY KEY,                 -- TKT_<ts>_<rand>
  org_id TEXT NOT NULL,
  provider TEXT NOT NULL,              -- 'jira' | 'pagerduty' | 'servicenow'
  credential_id TEXT NOT NULL,         -- integration_credentials.id (vault reference — NO inline secrets)
  settings_json TEXT NOT NULL DEFAULT '{}',
  -- jira: { project_key, issue_type='Task', labels=[] }
  min_severity TEXT NOT NULL DEFAULT 'high',
  incident_type_filter TEXT,           -- JSON array or NULL (= all), same semantics as governance_webhook_config
  enabled INTEGER NOT NULL DEFAULT 1,
  resolve_sync INTEGER NOT NULL DEFAULT 1,   -- reserved for Phase 3/4 (PD resolve / Jira comment on close)
  rate_limit_max INTEGER NOT NULL DEFAULT 10,
  rate_limit_window_s INTEGER NOT NULL DEFAULT 300,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  last_delivery_at TEXT,
  last_status INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_config_org ON governance_ticket_config(org_id);
CREATE INDEX IF NOT EXISTS idx_ticket_config_enabled ON governance_ticket_config(enabled);

CREATE TABLE IF NOT EXISTS governance_incident_tickets (
  id TEXT PRIMARY KEY,                 -- TKR_<ts>_<rand>
  incident_id TEXT NOT NULL,
  config_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  ticket_ref TEXT,                     -- 'PROJ-123' | PD dedup_key | SNOW number
  ticket_url TEXT,                     -- browse URL (NULL when the provider has none)
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'created'|'failed'|'resolve_synced'
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_tickets_dedup
  ON governance_incident_tickets(incident_id, config_id);
CREATE INDEX IF NOT EXISTS idx_incident_tickets_incident ON governance_incident_tickets(incident_id);
CREATE INDEX IF NOT EXISTS idx_incident_tickets_config_created
  ON governance_incident_tickets(config_id, created_at);
