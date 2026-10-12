-- QUOX-CLAUDE-3 (quox#672): remote session control. A control row is a
-- command (allowlisted in lib/slotControl.js, today only 'compact') requested
-- for the session holding a slot. Authority is decided server-side at POST
-- time; the slot's keeper (the slot VOICE) polls pending rows and acks them.
-- status moves pending -> done|failed exactly once (CAS in the store).
CREATE TABLE IF NOT EXISTS dev_slot_controls (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  slot_id       TEXT NOT NULL,
  slot_name     TEXT NOT NULL,
  command       TEXT NOT NULL,
  requested_by  TEXT,
  requested_via TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  result        TEXT,
  created_at    TEXT NOT NULL,
  acked_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_dev_slot_controls_pending ON dev_slot_controls (org_id, slot_id, status);
