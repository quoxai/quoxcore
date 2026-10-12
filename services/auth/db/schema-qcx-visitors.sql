-- QCX-3.2 — Widget visitor memory.
--
-- Per (widget × visitor_id). Records first_seen / last_seen /
-- identified_attrs / conversation_count so a returning visitor gets
-- recognised and the collector can inject a "continue where you left
-- off" preamble into the LLM system prompt.
--
-- No raw secrets / passwords / free-form attrs — auth.lib.widgetVisitorMemory
-- ATTR_ALLOWLIST drops everything outside the supported set before write.

CREATE TABLE IF NOT EXISTS widget_visitors (
    visitor_id TEXT NOT NULL,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,

    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    conversation_count INTEGER NOT NULL DEFAULT 0,

    -- JSON of allowlisted identify-attrs. Merged (not overwritten) on upsert
    -- by widgetVisitorMemory.mergeIdentifiedAttrs().
    identified_attrs_json TEXT NOT NULL DEFAULT '{}',

    -- Reserved for QCX-3 follow-ons (topic tracking, style profile).
    topics_json TEXT NOT NULL DEFAULT '[]',
    style_profile_json TEXT NOT NULL DEFAULT '{}',

    -- QCL-IDENTITY P1 — verified visitor identity (HMAC). external_user_id
    -- is the customer's own stable id for the visitor; verified=1 only
    -- when the collector confirmed HMAC-SHA256(user_id, widget.identity_secret)
    -- === user_hash on identify(). See migrations/078-widget-visitors-identity-verification.sql.
    external_user_id TEXT,
    verified INTEGER NOT NULL DEFAULT 0,

    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    PRIMARY KEY (widget_id, visitor_id)
);

CREATE INDEX IF NOT EXISTS idx_widget_visitors_org_last_seen ON widget_visitors(org_id, last_seen DESC);
