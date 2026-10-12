-- CW-FU: close cross-org leak risk — every message carries its own org_id
ALTER TABLE widget_messages ADD COLUMN org_id TEXT;
UPDATE widget_messages
   SET org_id = (SELECT c.org_id FROM widget_conversations c WHERE c.id = widget_messages.conversation_id)
 WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_org ON widget_messages(org_id, created_at);
