-- QUOXIDENTITY P10 (splinter shared slot): several attached sessions of ONE
-- agent (splinters) share the agent's bound slot. The holder stays the single
-- recorded holder; additional sessions join as MEMBERS. member_key is the
-- attach_lease_id, so a member is unforgeable (it comes from the verified
-- attach token). A member heartbeat keeps the hold alive; the slot only goes
-- stale when the holder and every member have lapsed.
CREATE TABLE IF NOT EXISTS dev_slot_members (
  org_id            TEXT NOT NULL,
  slot_name         TEXT NOT NULL,
  member_key        TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  splinter          TEXT,
  member_session    TEXT NOT NULL,
  joined_at         TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  PRIMARY KEY (org_id, slot_name, member_key)
);

-- Message claiming + addressing: first claimer wins (CAS on claimed_by IS NULL).
ALTER TABLE dev_slot_messages ADD COLUMN claimed_by TEXT;
ALTER TABLE dev_slot_messages ADD COLUMN claimed_at TEXT;
ALTER TABLE dev_slot_messages ADD COLUMN addressed_to TEXT;
