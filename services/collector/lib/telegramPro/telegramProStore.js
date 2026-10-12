/**
 * Telegram Pro Store, QTG-PRO P0.
 *
 * Durable base for the Telegram Pro subsystem: update dedup, forum topic
 * registry, and channel bindings. All three tables live in a single
 * SQLite file, kept separate from the plain telegramConversationStore's
 * channel-conversations.db and never shared with aee.db/volt.db.
 *
 * Table and column names in this schema are shaped to line up with the
 * planned P1 auth-side migration (multi-bot, multi-tenant, forum topics),
 * so renaming should not be needed when that lands.
 *
 * Mirrors the durable-store idiom already used by channelConversationStore.js
 * / reflectionMiningWatermark.js / feedWatermark.js / gpuNodesStore.js:
 * better-sqlite3, its own SQLite file, a connection cache keyed by resolved
 * dbPath (so tests point at an isolated temp file), schema applied inline
 * via CREATE TABLE IF NOT EXISTS, and every read/write wrapped so a DB
 * failure degrades gracefully rather than throwing to callers.
 */

'use strict';

const Database = require('better-sqlite3');
const { existsSync, mkdirSync } = require('fs');
const { dirname } = require('path');

const DEFAULT_DB_PATH = process.env.TELEGRAM_PRO_DB_PATH || '/var/lib/quox/telegram-pro.db';

const VALID_TARGET_KINDS = new Set(['session', 'agent', 'team', 'hitl_inbox', 'owner']);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS telegram_updates_seen (
    bot_id     TEXT NOT NULL,
    update_id  INTEGER NOT NULL,
    seen_at    INTEGER NOT NULL,
    PRIMARY KEY (bot_id, update_id)
  );

  CREATE TABLE IF NOT EXISTS telegram_chats (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id             TEXT,
    bot_id             TEXT NOT NULL,
    tg_chat_id         TEXT NOT NULL,
    chat_type          TEXT,
    is_forum           INTEGER DEFAULT 0,
    message_thread_id  INTEGER,
    title              TEXT,
    status             TEXT DEFAULT 'active',
    created_at         INTEGER,
    updated_at         INTEGER,
    UNIQUE (bot_id, tg_chat_id, message_thread_id)
  );

  CREATE TABLE IF NOT EXISTS channel_bindings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id              TEXT,
    provider            TEXT NOT NULL DEFAULT 'telegram',
    bot_id              TEXT,
    tg_chat_id          TEXT NOT NULL,
    message_thread_id   INTEGER,
    target_kind         TEXT NOT NULL,
    target_id           TEXT,
    mode                TEXT NOT NULL DEFAULT 'primary',
    reply_routing_json  TEXT,
    created_by          TEXT,
    created_at          INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_bindings_primary_unique
    ON channel_bindings (bot_id, tg_chat_id, message_thread_id)
    WHERE mode = 'primary';

  CREATE INDEX IF NOT EXISTS idx_channel_bindings_target
    ON channel_bindings (target_kind, target_id);

  CREATE INDEX IF NOT EXISTS idx_telegram_chats_lookup
    ON telegram_chats (bot_id, tg_chat_id);

  CREATE TABLE IF NOT EXISTS outbound_message_refs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id              TEXT,
    tg_chat_id          TEXT,
    message_thread_id   INTEGER,
    message_id          INTEGER,
    kind                TEXT,
    created_at          INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_outbound_message_refs_lookup
    ON outbound_message_refs (tg_chat_id, message_id);

  CREATE TABLE IF NOT EXISTS telegram_poll_offsets (
    bot_id       TEXT PRIMARY KEY,
    next_offset  INTEGER NOT NULL,
    updated_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS telegram_bot_ingest (
    bot_id      TEXT PRIMARY KEY,
    mode        TEXT NOT NULL DEFAULT 'polling' CHECK(mode IN ('polling', 'webhook')),
    updated_at  INTEGER
  );
`;

// Connections cached per resolved dbPath: tests point at an isolated temp
// file without disturbing (or being disturbed by) the production default,
// and repeated calls within a process reuse one open handle.
const _connections = new Map();
const _warnedPaths = new Set();

function resolveDb(dbPath) {
  const resolvedPath = dbPath || DEFAULT_DB_PATH;
  if (_connections.has(resolvedPath)) return _connections.get(resolvedPath);

  try {
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const db = new Database(resolvedPath);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    _connections.set(resolvedPath, db);
    return db;
  } catch (err) {
    if (!_warnedPaths.has(resolvedPath)) {
      console.error(`[TelegramProStore] failed to open durable store at ${resolvedPath}, falling back to no-persistence behavior this process, ${err.message}`);
      _warnedPaths.add(resolvedPath);
    }
    _connections.set(resolvedPath, null); // cache the failure too, don't retry every call
    return null;
  }
}

/**
 * Public accessor used by the sibling modules in this directory
 * (updateDedup.js, threadRegistry.js, bindingStore.js). Returns the shared
 * database handle for a resolved dbPath, or null if the store is
 * unavailable (callers must fail soft, per the idiom above).
 */
function getDb(dbPath) {
  return resolveDb(dbPath);
}

/**
 * Test-only escape hatch: close and drop a cached connection so a test can
 * reopen the same dbPath fresh (simulating a process restart against the
 * same durable file) without connections leaking across test files.
 */
function _closeForTest(dbPath) {
  const resolvedPath = dbPath || DEFAULT_DB_PATH;
  const db = _connections.get(resolvedPath);
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
  _connections.delete(resolvedPath);
  _warnedPaths.delete(resolvedPath);
}

// ============================================================================
// Poll offsets (QTG-PRO, self-hosted long-polling)
// ============================================================================

/**
 * Returns the next getUpdates offset to use for a bot, or null if none has
 * been persisted yet (fresh bot, or store unavailable — either way the
 * poller starts from Telegram's default: no offset param on the first call).
 */
function getOffset({ botId, dbPath } = {}) {
  if (!botId) throw new Error('getOffset requires botId');
  const db = getDb(dbPath);
  if (!db) return null;
  try {
    const row = db.prepare('SELECT next_offset FROM telegram_poll_offsets WHERE bot_id = ?').get(botId);
    return row ? row.next_offset : null;
  } catch (err) {
    console.error(`[TelegramProStore] getOffset failed for ${botId}, ${err.message}`);
    return null;
  }
}

/**
 * Persists the next getUpdates offset for a bot (upsert). Fails soft: a
 * write failure here means the next restart may re-deliver a small batch
 * of already-processed updates, which updateDedup absorbs.
 *
 * @returns {boolean} true on success, false if the store is unavailable or
 *   the write failed.
 */
function setOffset({ botId, offset, dbPath } = {}) {
  if (!botId) throw new Error('setOffset requires botId');
  if (typeof offset !== 'number') throw new Error('setOffset requires a numeric offset');
  const db = getDb(dbPath);
  if (!db) return false;
  try {
    db.prepare(`
      INSERT INTO telegram_poll_offsets (bot_id, next_offset, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET next_offset = excluded.next_offset, updated_at = excluded.updated_at
    `).run(botId, offset, Date.now());
    return true;
  } catch (err) {
    console.error(`[TelegramProStore] setOffset failed for ${botId}, ${err.message}`);
    return false;
  }
}

// ============================================================================
// Bot ingest mode (QTG-PRO): polling vs webhook, per bot
// ============================================================================

/**
 * Returns a bot's configured ingest mode. Defaults to 'polling' (the
 * self-hosted default, per QTG-PRO) when no row exists yet, or the store is
 * unavailable.
 */
function getMode({ botId, dbPath } = {}) {
  if (!botId) throw new Error('getMode requires botId');
  const db = getDb(dbPath);
  if (!db) return 'polling';
  try {
    const row = db.prepare('SELECT mode FROM telegram_bot_ingest WHERE bot_id = ?').get(botId);
    return row ? row.mode : 'polling';
  } catch (err) {
    console.error(`[TelegramProStore] getMode failed for ${botId}, ${err.message}`);
    return 'polling';
  }
}

/**
 * Sets a bot's ingest mode (upsert). Returns true on success, false if the
 * store is unavailable, the write failed, or mode is not a valid value.
 */
function setMode({ botId, mode, dbPath } = {}) {
  if (!botId) throw new Error('setMode requires botId');
  if (mode !== 'polling' && mode !== 'webhook') throw new Error(`setMode: invalid mode "${mode}"`);
  const db = getDb(dbPath);
  if (!db) return false;
  try {
    db.prepare(`
      INSERT INTO telegram_bot_ingest (bot_id, mode, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at
    `).run(botId, mode, Date.now());
    return true;
  } catch (err) {
    console.error(`[TelegramProStore] setMode failed for ${botId}, ${err.message}`);
    return false;
  }
}

/**
 * Lists every bot_id with a persisted ingest-mode row. Used at boot to find
 * bots configured for polling. Returns [] if the store is unavailable.
 */
function listModes({ dbPath } = {}) {
  const db = getDb(dbPath);
  if (!db) return [];
  try {
    return db.prepare('SELECT bot_id, mode FROM telegram_bot_ingest').all();
  } catch (err) {
    console.error(`[TelegramProStore] listModes failed, ${err.message}`);
    return [];
  }
}

module.exports = {
  getDb,
  _closeForTest,
  DEFAULT_DB_PATH,
  VALID_TARGET_KINDS,
  getOffset,
  setOffset,
  getMode,
  setMode,
  listModes,
};
