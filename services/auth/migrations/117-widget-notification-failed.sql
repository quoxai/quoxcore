-- QUOXCHAT-BRUTALOOP wave 7: a lead/handoff whose internal inbox POST failed
-- must be visible to the admin (banner), not just logged. Flag both rows.
ALTER TABLE widget_leads ADD COLUMN notification_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE widget_conversations ADD COLUMN notification_failed INTEGER NOT NULL DEFAULT 0;
