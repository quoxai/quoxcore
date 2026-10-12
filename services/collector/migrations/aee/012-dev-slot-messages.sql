-- 012-dev-slot-messages.sql — DEVSUITE-SLOTS Phase 5 say/read seam (design in
-- QuoxPlan DEVSUITE-SLOTS plan v2 sections 1b/1c/2c).
--
-- dev_slot_messages is a CACHE of the slot's Matrix room timeline, not the
-- truth. The room (dev_slots.matrix_room_id, derived in phase 4) stays the
-- source of record; this table exists only because no server-side Matrix
-- room-timeline read precedent exists yet in this codebase (checked:
-- collector lib + routes, quoxchatMatrixRelay.js only ever posts, never
-- reads a room's history). Written by POST /api/v1/slots/:name/say (a
-- session's outbound text, after it is relayed into the room) and by
-- POST /api/v1/slots/:name/inbound (service-key bridge-side ingestion of
-- what already landed in the room from elsewhere). Read by
-- GET /api/v1/slots/:name/messages. Phase 6 unifies the read onto a real
-- Matrix timeline query and this table becomes redundant.

CREATE TABLE IF NOT EXISTS dev_slot_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  slot_name TEXT NOT NULL,
  from_label TEXT,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'say',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dev_slot_messages_slot_ts ON dev_slot_messages(org_id, slot_id, created_at);
