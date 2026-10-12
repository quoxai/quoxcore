-- Multi-tenancy Phase 2, Tier 2
ALTER TABLE escalation_stages ADD COLUMN org_id TEXT;
UPDATE escalation_stages
SET org_id = (
    SELECT i.org_id FROM inbox_items ii
    JOIN inboxes i ON ii.inbox_id = i.id
    WHERE ii.id = escalation_stages.inbox_item_id
)
WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_escalation_stages_org ON escalation_stages(org_id);
