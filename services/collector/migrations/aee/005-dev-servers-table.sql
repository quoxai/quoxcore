-- 005-dev-servers-table.sql — collector AEE database (aee.db)
--
-- DEVSUITE-DEVMODE Phase 3: quoxagent's new `dev` builtin plugin family
-- (dev.register capability, quoxagent commit 865a17b) reports its
-- registerStatus() shape on the existing fleet heartbeat
-- (POST /api/v1/heartbeat) via a `dev_capabilities` field. Mirrors B1
-- (QUOXGPU #149)'s durable gpu_nodes pattern: the in-memory `agents` Map
-- (server.js) is a fast liveness cache, this table is the source of truth
-- that survives a collector restart. See lib/devServersStore.js.
--
-- Only heartbeats carrying a dev_capabilities object are persisted here —
-- plain QuoxAgent hosts without the dev plugin enabled are never written to
-- this table (mirrors gpu_nodes' isGpuHeartbeat gate).

CREATE TABLE IF NOT EXISTS dev_servers (
  host_id              TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL DEFAULT 'default',
  hostname             TEXT,
  profile_verified     INTEGER NOT NULL DEFAULT 0,
  profile_version      TEXT,
  enabled_capabilities TEXT NOT NULL DEFAULT '[]',
  known_capabilities   TEXT NOT NULL DEFAULT '[]',
  checked_at           TEXT,
  first_registered_at  INTEGER NOT NULL,
  last_seen_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dev_servers_org ON dev_servers(org_id);
