-- QUOXON-ROOMS: a slot is a group room. Membership (subscribe + post) is separate from the
-- hold (exclusive, task ownership). One row per (org, slot, session); org scoping is structural.
CREATE TABLE IF NOT EXISTS dev_slot_room_members (
  org_id     TEXT NOT NULL,
  slot_id    TEXT NOT NULL,
  slot_name  TEXT NOT NULL,
  session    TEXT NOT NULL,
  person     TEXT,
  identity   TEXT,
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, slot_id, session)
);
CREATE INDEX IF NOT EXISTS idx_dev_slot_room_members_session ON dev_slot_room_members (org_id, session);
