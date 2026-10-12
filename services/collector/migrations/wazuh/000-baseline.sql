-- 000-baseline.sql — collector Wazuh deploy database (wazuh.db)
--
-- The CURRENT full schema for wazuh.db (verbatim copy of the inline CREATE
-- statements previously executed directly in server.js at boot), wrapped in
-- idempotent CREATE ... IF NOT EXISTS form so a genuinely FRESH database
-- builds cleanly from migrations alone. On an EXISTING database (tables
-- already present, e.g. the live dev db), every statement below is a no-op
-- — nothing is dropped or recreated.

CREATE TABLE IF NOT EXISTS deploy_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname TEXT NOT NULL,
  ip TEXT NOT NULL,
  ssh_user TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  deployed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deploy_hostname ON deploy_log(hostname);
CREATE INDEX IF NOT EXISTS idx_deploy_time ON deploy_log(deployed_at);
