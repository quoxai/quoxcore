-- QSKL-SAFETY Slice 2: Skill Firewall Log
-- Every firewall scan (allow or block) is recorded here.
-- source values: 'skill_manage' | 'api_publish' | 'api_patch' | 'patch_flow'
-- skill_id is NULL when allow=false on a create path (no skill DB row was ever created).
-- pending_skill_name carries the would-be skill name for those blocked-create rows.

CREATE TABLE IF NOT EXISTS skill_firewall_log (
  id                  TEXT PRIMARY KEY,                    -- ULID
  skill_id            TEXT,                                -- NULL for blocked create attempts
  pending_skill_name  TEXT,                                -- set when skill_id IS NULL (blocked create)
  version             INTEGER NOT NULL,
  org_id              TEXT,
  author_id           TEXT,
  scanned_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  allow               BOOLEAN NOT NULL,
  findings            JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason              TEXT,
  rule_set_version    INTEGER NOT NULL,
  source              TEXT NOT NULL                        -- 'skill_manage' | 'api_publish' | 'api_patch' | 'patch_flow'
);

CREATE INDEX IF NOT EXISTS idx_skill_firewall_log_skill
  ON skill_firewall_log (skill_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_skill_firewall_log_org
  ON skill_firewall_log (org_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_skill_firewall_log_allow
  ON skill_firewall_log (allow, scanned_at DESC);
