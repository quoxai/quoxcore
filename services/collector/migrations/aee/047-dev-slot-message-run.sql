-- SLOT-RUN (owner 2026-10-16): a slot message may carry ONE command for the human
-- to run in their own terminal (`quox slot say <slot> --run '<command>' "<why>"`).
-- Stored verbatim, validated at the say route (max 2000 chars, one line, no
-- control or bidi characters), NEVER executed server-side: the quox TUI shows it
-- in full and runs it only on the human's own y. NULL on every other message.
ALTER TABLE dev_slot_messages ADD COLUMN run_command TEXT;
