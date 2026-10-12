-- 088-telegram-pro.sql
-- QTG-PRO #P1: durable org-scoped schema for the Telegram Pro subsystem.
--
-- The collector currently runs P0 file/SQLite stores shaped to line up with
-- this migration (see services/collector/lib/telegramPro/telegramProStore.js
-- header comment: "shaped to line up with the planned P1 auth-side
-- migration ... so renaming should not be needed when that lands"). This
-- migration lands the durable, multi-tenant, multi-bot version of that
-- schema on the auth side. P2 wires the collector to read/write through
-- these tables instead of its own telegram-pro.db; this migration ships
-- schema + routes only, no collector changes.
--
-- Bot tokens are NEVER stored here — telegram_bots.credential_id points at
-- integration_credentials (the vault), which holds the encrypted token.
--
-- Five tables:
--   telegram_bots        — one row per registered bot (multi-bot per org)
--   telegram_chats       — chats/forum-topics a bot has seen, normalized
--                          under the owning bot (unlike the collector's P0
--                          flat store, which keys chats by bot_id directly)
--   channel_bindings     — routes a chat (or forum topic) to a Quox target
--                          (session/agent/team/hitl_inbox/owner); one
--                          primary binding per chat, any number of mirrors
--   telegram_user_links  — verified mapping of a Quox user to a numeric
--                          Telegram user id (never username — usernames are
--                          recyclable and cannot be trusted as an identity)
--   reaction_policies    — org-level emoji -> HITL action mapping (approve/
--                          deny/ack/escalate). Schema only in this
--                          migration; no default-org seeding precedent was
--                          found in prior migrations (schema-* files seed
--                          instance-wide config, not per-org rows), so
--                          per-org defaults are left to the route layer
--                          when reaction_policies routes are built (not in
--                          this P1 scope — see routes/telegramPro.js).

CREATE TABLE IF NOT EXISTS telegram_bots (
    id                  TEXT PRIMARY KEY,                    -- ULID
    org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    credential_id       TEXT NOT NULL REFERENCES integration_credentials(id) ON DELETE CASCADE,
    bot_username        TEXT,                                -- @handle, no leading @
    bot_user_id         TEXT NOT NULL,                        -- Telegram's numeric bot id (external, stored as TEXT)
    kind                TEXT NOT NULL DEFAULT 'gateway'
        CHECK (kind IN ('gateway', 'agent', 'notify')),
    agent_id            TEXT,                                -- default agent for this bot: assistants.id or a
                                                               -- core agent id ('quox'); NULL = no default (mirrors
                                                               -- matrix_rooms.default_agent, no FK — mixed id space)
    webhook_secret_hash TEXT,                                 -- hash of the per-bot Telegram webhook secret token
    status              TEXT NOT NULL DEFAULT 'active',       -- active | disabled
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, bot_user_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_bots_org ON telegram_bots(org_id);
CREATE INDEX IF NOT EXISTS idx_telegram_bots_credential ON telegram_bots(credential_id);
CREATE INDEX IF NOT EXISTS idx_telegram_bots_status ON telegram_bots(status);

CREATE TABLE IF NOT EXISTS telegram_chats (
    id                  TEXT PRIMARY KEY,                    -- ULID
    org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    bot_id              TEXT NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
    tg_chat_id          TEXT NOT NULL,                        -- Telegram's chat id (external, stored as TEXT)
    chat_type           TEXT,                                 -- private | group | supergroup | channel
    is_forum            INTEGER NOT NULL DEFAULT 0,
    message_thread_id   INTEGER,                              -- forum topic id; NULL = the chat's General topic
    title               TEXT,
    status              TEXT NOT NULL DEFAULT 'active',
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(bot_id, tg_chat_id, message_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_chats_org ON telegram_chats(org_id);
CREATE INDEX IF NOT EXISTS idx_telegram_chats_bot ON telegram_chats(bot_id);
CREATE INDEX IF NOT EXISTS idx_telegram_chats_lookup ON telegram_chats(bot_id, tg_chat_id);

CREATE TABLE IF NOT EXISTS channel_bindings (
    id                  TEXT PRIMARY KEY,                    -- ULID
    org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL DEFAULT 'telegram'
        CHECK (provider IN ('telegram', 'slack')),
    chat_id             TEXT NOT NULL REFERENCES telegram_chats(id) ON DELETE CASCADE,
    target_kind         TEXT NOT NULL
        CHECK (target_kind IN ('session', 'agent', 'team', 'hitl_inbox', 'owner')),
    target_id           TEXT,
    mode                TEXT NOT NULL DEFAULT 'primary'
        CHECK (mode IN ('primary', 'mirror')),
    reply_routing_json  TEXT DEFAULT '{}',
    created_by          TEXT REFERENCES users(id),
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One primary binding per chat; any number of mirror bindings.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_bindings_primary_unique
    ON channel_bindings(chat_id)
    WHERE mode = 'primary';

CREATE INDEX IF NOT EXISTS idx_channel_bindings_org ON channel_bindings(org_id);
CREATE INDEX IF NOT EXISTS idx_channel_bindings_chat ON channel_bindings(chat_id);
CREATE INDEX IF NOT EXISTS idx_channel_bindings_target ON channel_bindings(target_kind, target_id);

CREATE TABLE IF NOT EXISTS telegram_user_links (
    id              TEXT PRIMARY KEY,                        -- ULID
    org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tg_user_id      INTEGER NOT NULL,                         -- Telegram's numeric user id — NEVER username
                                                               -- (usernames are recyclable, not a stable identity)
    tg_username     TEXT,                                     -- last-known @handle, display-only
    verified_at     TEXT,
    link_code_hash  TEXT,                                     -- hash of the one-time linking code (P2 /link flow)
    expires_at      TEXT,                                     -- linking code expiry, before verified_at is set
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, tg_user_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_user_links_org ON telegram_user_links(org_id);
CREATE INDEX IF NOT EXISTS idx_telegram_user_links_user ON telegram_user_links(user_id);

CREATE TABLE IF NOT EXISTS reaction_policies (
    id          TEXT PRIMARY KEY,                            -- ULID
    org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    emoji       TEXT NOT NULL,
    action      TEXT NOT NULL
        CHECK (action IN ('approve', 'deny', 'ack', 'escalate')),
    scope       TEXT NOT NULL DEFAULT 'global',               -- 'global' (org-wide default) or a chat_id/target
                                                               -- scoping the override to one binding
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, emoji, scope)
);

CREATE INDEX IF NOT EXISTS idx_reaction_policies_org ON reaction_policies(org_id);
