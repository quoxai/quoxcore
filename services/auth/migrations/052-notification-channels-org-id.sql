-- Multi-Org Foundation
ALTER TABLE notification_channels ADD COLUMN org_id TEXT;
UPDATE notification_channels
SET org_id = (SELECT om.org_id FROM org_memberships om WHERE om.user_id = notification_channels.user_id AND om.status = 'active' LIMIT 1)
WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_channels_org ON notification_channels(org_id);
DROP INDEX IF EXISTS idx_notification_channels_user_type;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_channels_user_org_type ON notification_channels(user_id, channel_type, org_id);
