-- 000-baseline.sql -- collector Security engagement/scope database (security.db)
--
-- QUOX-SECURITY Phase 0: the engagement/scope object and target verification
-- records that every future security capability call must be checked
-- against before it may run. No findings table yet (Phase 1's job, YAGNI,
-- nothing produces findings until an agent capability exists).
--
-- risk_ceiling / environment_tier / status / target verification_status are
-- app-validated enums (SQLite has no native enum type), see
-- lib/securityEngagement.js for the allowed value sets.

CREATE TABLE IF NOT EXISTS security_engagements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  environment_tier TEXT NOT NULL,
  risk_ceiling TEXT NOT NULL,
  exclusions_json TEXT NOT NULL DEFAULT '[]',
  time_window_start TEXT,
  time_window_end TEXT,
  credentials_ref TEXT,
  evidence_retention_days INTEGER,
  responsible_org_id TEXT,
  responsible_project TEXT,
  authorization_record_json TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_security_engagements_org ON security_engagements(org_id);
CREATE INDEX IF NOT EXISTS idx_security_engagements_status ON security_engagements(status);

CREATE TABLE IF NOT EXISTS security_targets (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES security_engagements(id),
  org_id TEXT NOT NULL,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  verification_method TEXT,
  verification_token TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verified_at TEXT,
  verification_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_security_targets_engagement ON security_targets(engagement_id);
CREATE INDEX IF NOT EXISTS idx_security_targets_org ON security_targets(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_security_targets_unique ON security_targets(engagement_id, type, value);
