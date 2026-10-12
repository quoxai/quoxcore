-- BRAIN2-W2 2: last-known-good value of privacy-RESTRICTING org settings
-- (QUOXBRAIN_EMBED_EXCLUDE_VAULTS, QUOXDREAM_ALLOW_LLM_TEXT). Written every
-- time the collector answers the settings lookup; read only when the lookup
-- fails, so a collector outage can never silently drop an org's restriction.
-- Persisted here (not in memory) so it survives a quoxbrain restart.
CREATE TABLE IF NOT EXISTS privacy_setting_lkg (
  org_id     TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, key)
);
