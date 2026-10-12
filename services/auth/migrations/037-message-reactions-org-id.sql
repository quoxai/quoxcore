-- Multi-tenancy Phase 2, Tier 1
ALTER TABLE message_reactions ADD COLUMN org_id TEXT;
UPDATE message_reactions
SET org_id = (SELECT org_id FROM messages WHERE messages.id = message_reactions.message_id)
WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_reactions_org ON message_reactions(org_id);
