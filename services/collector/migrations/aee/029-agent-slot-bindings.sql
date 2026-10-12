-- 029-agent-slot-bindings.sql — collector AEE database (aee.db)
--
-- QuoxIdentity P3 (territory F, docs/QUOXIDENTITY_P3_CONTRACT.md): an agent
-- identity owns a durable slot ADDRESS. This table binds one registry agent
-- id to one existing dev_slots row, per org — the binding itself does not
-- create or touch the slot (see lib/agentSlotBindings.js); it is pure
-- pointer state, same denorm-pointer spirit as dev_slots.matrix_room_id
-- (011-dev-slots.sql), except here the pointer table is its own row rather
-- than a column on dev_slots, because the relationship is optional and
-- owned by a different territory (identity, not the slot registry itself).
--
-- Both UNIQUE constraints encode the P3 contract literally: "One slot per
-- agent, one agent per slot, org-scoped." UNIQUE(org_id, agent_id) stops an
-- agent from being bound to two addresses at once; UNIQUE(org_id, slot_name)
-- stops a slot address from answering to two agent identities at once. A
-- rebind (change an agent's slot, or hand a slot to a different agent) is a
-- delete-then-insert at the lib/agentSlotBindings.js layer, not an update —
-- INSERT OR REPLACE would silently violate whichever UNIQUE constraint the
-- new row doesn't collide on, e.g. leaving a stale row for the OTHER side of
-- the pair. Never done that way here.
--
-- id follows the "TEXT PK ULID" contract wording via the same crypto-random
-- prefixed-hex convention as dev_slots.id ("slot_...") and
-- dev_slot_messages.id ("slotmsg_..."), not a real ULID library — this repo
-- has no ULID dependency in the collector service, see the store's newBindingId().

CREATE TABLE IF NOT EXISTS agent_slot_bindings (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  slot_name   TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(org_id, agent_id),
  UNIQUE(org_id, slot_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_slot_bindings_org ON agent_slot_bindings(org_id);
