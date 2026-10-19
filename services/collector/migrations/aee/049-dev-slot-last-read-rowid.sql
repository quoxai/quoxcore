-- 049-dev-slot-last-read-rowid.sql: the slot read cursor is a MESSAGE POSITION, not a clock.
--
-- last_read_at (020) was a millisecond timestamp and unread_count counted created_at > last_read_at, so a message
-- stamped in the same millisecond as the read, or one that landed between a route fetching messages and stamping
-- the read, was counted as read without ever being delivered: an owner message could sit unseen (WORKER2,
-- 2026-10-16). last_read_rowid is the rowid of the last dev_slot_messages row the holder actually received;
-- unread_count counts rows after it. last_read_at stays as the time of the read (presence, wait default cursor).
-- NULL means no position recorded yet (fresh checkout, or a row from before this migration: the old timestamp
-- rule applies until the next read). Same additive-ALTER pattern as 020.

ALTER TABLE dev_slots ADD COLUMN last_read_rowid INTEGER;
