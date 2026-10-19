-- SLOTS-REPLY (owner 2026-10-15): the SENDER's slot on every slot message, so a
-- reply goes to a slot (the one address) instead of a free-text session label
-- that nobody holds. Set only when the server verified the sender holds that slot
-- in the same org under the same authenticated identity; NULL otherwise and on
-- every row written before this migration (backward compatible).
ALTER TABLE dev_slot_messages ADD COLUMN from_slot TEXT;
