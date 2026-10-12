-- 014-dev-slot-bridges.sql — DEVSUITE-SLOTS phase 9: bridge rooms off env
-- vars per the no-env-only-config house rule (a feature merged with only an
-- env flag is not done).
--
-- dev_slot_bridges: the org-scoped, governed replacement for the
-- QUOX_SLOT_BRIDGE_ROOM / QUOX_SLOT_DISCORD_ROOM env vars that renderSlotLine
-- ToBridge used to read directly. One row per (org, platform); the env vars
-- remain a fallback only, read by the route when no row exists for an org
-- (see devSlotBridgesStore.js / server.js GET+PUT /api/v1/slots/bridges).

CREATE TABLE IF NOT EXISTS dev_slot_bridges (
  org_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  room_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (org_id, platform)
);
