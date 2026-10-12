-- Inbox Revamp
ALTER TABLE inbox_item_assignees ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbox_item_assignees ADD COLUMN is_flagged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbox_item_assignees ADD COLUMN archived_at TEXT;
ALTER TABLE inbox_item_assignees ADD COLUMN snoozed_until TEXT;
CREATE INDEX IF NOT EXISTS idx_inbox_assignees_read ON inbox_item_assignees(is_read);
CREATE INDEX IF NOT EXISTS idx_inbox_assignees_flagged ON inbox_item_assignees(is_flagged);
CREATE INDEX IF NOT EXISTS idx_inbox_assignees_archived ON inbox_item_assignees(archived_at);
CREATE INDEX IF NOT EXISTS idx_inbox_assignees_snoozed ON inbox_item_assignees(snoozed_until);
UPDATE inbox_item_assignees SET is_read = 1 WHERE viewed_at IS NOT NULL;
