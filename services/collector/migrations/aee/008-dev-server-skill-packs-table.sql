-- 008-dev-server-skill-packs-table.sql — collector AEE database (aee.db)
--
-- DEVSUITE-SKILLS Phase 3 (sync/update channel + drift surfacing). Until
-- now, checking whether a host's dev skill pack is current required a LIVE
-- Bastion SSH round-trip every time (skillPackInstaller.js's
-- buildStatusCheckCommand + checkPackStatus, called via callBastion). This
-- table is the durable, dashboard-queryable record of what's installed
-- where — mirrors the dev_servers / gpu_nodes pattern (005/000): UPSERT
-- keyed by (host_id, pack_id), so a collector restart or a plain GET
-- request never needs a live remote exec for the common case. See
-- lib/devServerSkillPacksStore.js.
--
-- status vocabulary: 'current' (installed_content_hash matches the pack's
-- live-recomputed hash), 'drifted' (mismatch — a skill file changed on
-- disk without a version bump, or the pack version itself moved on),
-- 'unknown' (presence/hash could not be confirmed, e.g. a live Bastion
-- check failed or the host was never confirmed installed). A missing row
-- entirely (no host_id/pack_id match) also reads as "unknown" at the API
-- layer, but is not itself a stored status value.

CREATE TABLE IF NOT EXISTS dev_server_skill_packs (
  host_id                 TEXT NOT NULL,
  pack_id                 TEXT NOT NULL,
  org_id                  TEXT NOT NULL DEFAULT 'default',
  installed_version       TEXT,
  installed_content_hash  TEXT,
  installed_at            INTEGER,
  last_checked_at         INTEGER,
  status                  TEXT NOT NULL DEFAULT 'unknown',
  PRIMARY KEY (host_id, pack_id)
);

CREATE INDEX IF NOT EXISTS idx_dev_server_skill_packs_org ON dev_server_skill_packs(org_id);
