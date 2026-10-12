-- QUOXCHAT-BRUTALOOP (2026-10-09): the visitor GDPR export and the evidence
-- export both SELECT widget_conversations.page_url, but no migration ever
-- created it, so every real export 500'd (a test patched the column into its
-- private DB and hid it). Add it; persist-message stores the first page.
ALTER TABLE widget_conversations ADD COLUMN page_url TEXT;
