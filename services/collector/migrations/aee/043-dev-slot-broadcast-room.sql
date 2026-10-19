-- QUOXON-BROADCAST: delivery status now means "stored in the slot"; the chat-room copy
-- (Matrix/Discord bridge) is tracked on its own: sent | sending | failed. NULL for rows
-- written before this column (status was delivered/queued then) and for unknown slots.
ALTER TABLE dev_slot_broadcast_deliveries ADD COLUMN room TEXT;
