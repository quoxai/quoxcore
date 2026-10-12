-- 017-dev-slot-discord-channel.sql — DEVSUITE-SLOTS benchmark item 5:
-- per-slot Discord channels (design decided in notes #2875/#2876 and the
-- 2026-08-20 owner decisions).
--
-- The channel follows the SLOT, not the session: provisioned on slot
-- create, healed on checkout if missing, and NEVER deleted on retire (the
-- channel is a place a human has been reading; it stays until a human
-- deletes it, with a "disconnected" status once its slot is gone). This
-- deliberately diverges from matrix_room_id, whose room IS deprovisioned
-- on retire.
--
-- Like matrix_room_id these are a denorm cache; Discord itself is where
-- the channel lives, and the daemon adopts an existing #<slot-name>
-- channel by name rather than duplicating it, so losing these columns
-- only costs a re-ensure. discord_webhook_url is the slot say path's
-- posting target INTO the slot's own channel (webhooks are per-channel);
-- it replaces the org-wide bridge webhook for slots that have one.

ALTER TABLE dev_slots ADD COLUMN discord_channel_id TEXT;
ALTER TABLE dev_slots ADD COLUMN discord_webhook_url TEXT;
