-- CORECOMMS audit: notification_channels.channel_type and
-- notification_deliveries.channel_type CHECK constraints (000-baseline.sql
-- lines 2467-2468 / 2501-2502) only allow ('email', 'slack', 'telegram',
-- 'in_app', 'webhook'), blocking the majority of the driver set registered
-- in services/collector/lib/channels/index.js. Widen both CHECKs to the
-- full 16 registered driver ids (plus 'in_app', which is a UI-only pseudo
-- channel handled via SSE in notificationRouter.js and is not a driver).
--
-- SQLite cannot ALTER a CHECK constraint, so this uses the standard
-- table-recreate pattern: create a new table with the wider CHECK and an
-- otherwise identical schema, copy rows across, drop the old table, rename
-- the new one into place, and recreate the indexes. notification_channels
-- is empty in production per the audit, but the copy step is written
-- correctly regardless of that assumption.
PRAGMA foreign_keys=OFF;

-- ---------------------------------------------------------------------------
-- notification_channels
-- ---------------------------------------------------------------------------
CREATE TABLE notification_channels_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id TEXT,
    channel_type TEXT NOT NULL
        CHECK (channel_type IN (
            'email', 'slack', 'telegram', 'in_app', 'webhook',
            'discord', 'msteams', 'twilio-sms', 'pagerduty', 'opsgenie',
            'mattermost', 'ntfy', 'pushover', 'google-chat', 'gotify',
            'rocketchat', 'line'
        )),
    enabled INTEGER NOT NULL DEFAULT 1,
    config_json TEXT DEFAULT '{}',
    preferences_json TEXT DEFAULT '{}',
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO notification_channels_new (
    id, user_id, org_id, channel_type, enabled, config_json,
    preferences_json, verified_at, created_at, updated_at
)
SELECT
    id, user_id, org_id, channel_type, enabled, config_json,
    preferences_json, verified_at, created_at, updated_at
FROM notification_channels;

DROP TABLE notification_channels;
ALTER TABLE notification_channels_new RENAME TO notification_channels;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_channels_user_org_type ON notification_channels(user_id, channel_type, org_id);
CREATE INDEX IF NOT EXISTS idx_notification_channels_org ON notification_channels(org_id);
CREATE INDEX IF NOT EXISTS idx_notification_channels_enabled ON notification_channels(enabled);

-- ---------------------------------------------------------------------------
-- notification_deliveries
-- ---------------------------------------------------------------------------
CREATE TABLE notification_deliveries_new (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    inbox_item_id TEXT REFERENCES inbox_items(id) ON DELETE SET NULL,
    escalation_stage_id TEXT REFERENCES escalation_stages(id) ON DELETE SET NULL,
    channel_type TEXT NOT NULL
        CHECK (channel_type IN (
            'email', 'slack', 'telegram', 'in_app', 'webhook',
            'discord', 'msteams', 'twilio-sms', 'pagerduty', 'opsgenie',
            'mattermost', 'ntfy', 'pushover', 'google-chat', 'gotify',
            'rocketchat', 'line'
        )),
    recipient TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'bounced')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_error TEXT,
    external_id TEXT,
    content_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT,
    delivered_at TEXT
);

INSERT INTO notification_deliveries_new (
    id, org_id, inbox_item_id, escalation_stage_id, channel_type, recipient,
    status, attempts, last_attempt_at, last_error, external_id, content_json,
    created_at, sent_at, delivered_at
)
SELECT
    id, org_id, inbox_item_id, escalation_stage_id, channel_type, recipient,
    status, attempts, last_attempt_at, last_error, external_id, content_json,
    created_at, sent_at, delivered_at
FROM notification_deliveries;

DROP TABLE notification_deliveries;
ALTER TABLE notification_deliveries_new RENAME TO notification_deliveries;

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_org ON notification_deliveries(org_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_item ON notification_deliveries(inbox_item_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status ON notification_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_recipient ON notification_deliveries(recipient);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created ON notification_deliveries(created_at DESC);

PRAGMA foreign_keys=ON;
