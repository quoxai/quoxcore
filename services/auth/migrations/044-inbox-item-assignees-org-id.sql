-- Multi-tenancy Phase 2, Tier 2
ALTER TABLE inbox_item_assignees ADD COLUMN org_id TEXT;
UPDATE inbox_item_assignees
SET org_id = (
    SELECT i.org_id FROM inbox_items ii
    JOIN inboxes i ON ii.inbox_id = i.id
    WHERE ii.id = inbox_item_assignees.inbox_item_id
)
WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_assignees_org ON inbox_item_assignees(org_id);
