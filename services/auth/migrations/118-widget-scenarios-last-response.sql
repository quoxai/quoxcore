-- QUOXCHAT-BRUTALOOP wave 10: keep the last simulated response text per
-- scenario so the admin can judge a failed security check instead of seeing
-- only a score and a substring note.
ALTER TABLE widget_scenarios ADD COLUMN last_response TEXT;
