-- Multi-tenancy Phase 2, Tier 1
ALTER TABLE conversation_participants ADD COLUMN org_id TEXT;
UPDATE conversation_participants
SET org_id = (SELECT org_id FROM conversations WHERE conversations.id = conversation_participants.conversation_id)
WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_participants_org ON conversation_participants(org_id);
