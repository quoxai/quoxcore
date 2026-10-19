-- QUOXON-BROADCAST: one /broadcast fans out to the org's held slots. The broadcast row
-- is the sender's record; one delivery row per recipient slot tracks receipt (status)
-- and acknowledgement (acked_at) separately. Execution tracking is v2.
CREATE TABLE IF NOT EXISTS dev_slot_broadcasts (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  text         TEXT NOT NULL,
  sender       TEXT,
  sender_identity TEXT,
  priority     TEXT NOT NULL DEFAULT 'normal',
  ack_required INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dev_slot_broadcasts_org ON dev_slot_broadcasts (org_id, created_at);
CREATE TABLE IF NOT EXISTS dev_slot_broadcast_deliveries (
  broadcast_id TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  slot_id      TEXT,
  slot_name    TEXT NOT NULL,
  status       TEXT NOT NULL,
  message_id   TEXT,
  detail       TEXT,
  acked_at     TEXT,
  acked_by     TEXT,
  PRIMARY KEY (broadcast_id, slot_name)
);
