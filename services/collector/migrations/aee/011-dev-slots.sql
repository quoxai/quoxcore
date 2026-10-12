-- 011-dev-slots.sql — DEVSUITE-SLOTS registry (design in QuoxPlan
-- DEVSUITE-SLOTS plan v2 section 2a).
--
-- dev_slots: a fixed, org-curated pool of NAMED addresses (T1..T8, or
-- `triage`/`builder`/`website`) that ephemeral agent sessions check out and
-- release. Checkout is a compare-and-swap on `state` (free -> held) so two
-- sessions racing the same slot cannot both win; a server-side sweep (never
-- a browser timer) moves a held slot whose heartbeat has lapsed to `stale`,
-- then frees it after a further TTL. UNIQUE(org_id, name) makes the slot
-- name the org-scoped address the CLI/dashboard/room derivation key off.

CREATE TABLE IF NOT EXISTS dev_slots (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'free',
  holder_session TEXT,
  holder_kind TEXT,
  host_id TEXT,
  matrix_room_id TEXT,
  checked_out_at TEXT,
  last_heartbeat_at TEXT,
  released_at TEXT,
  created_by TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_dev_slots_org_state ON dev_slots(org_id, state);
