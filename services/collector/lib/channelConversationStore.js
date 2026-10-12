/**
 * Channel Conversation Store, CORECOMMS-PERSIST.
 *
 * Durable channel to conversation threading table: maps an external channel
 * thread (Telegram chat_id, Slack channel:thread_ts, ...) to a Quox
 * conversation, with the turn history stored alongside it so an inbound
 * webhook bridge can survive a collector restart instead of losing all
 * threading state the moment the process (or one of several parallel
 * instances) restarts.
 *
 * Mirrors the proven durable-store idiom already used by
 * reflectionMiningWatermark.js / feedWatermark.js / gpuNodesStore.js: its
 * own SQLite file (never shares a file with aee.db/volt.db), a connection
 * cache keyed by resolved dbPath (so tests can point at an isolated temp
 * file), schema applied inline via CREATE TABLE IF NOT EXISTS (idempotent,
 * no separate migration runner needed for a self-contained store), and
 * every read/write wrapped so a DB failure degrades to "no durable state"
 * (null / false) and logs once, rather than throwing. Callers
 * (telegramConversationStore.js today, slackWebhook.js in future if it
 * gains real per-thread history) treat any failure here as "fall back to
 * in-memory only" and never let it break a live reply.
 */

'use strict';

const Database = require('better-sqlite3');
const { existsSync, mkdirSync } = require('fs');
const { dirname } = require('path');

const DEFAULT_DB_PATH = process.env.CHANNEL_CONVERSATIONS_DB_PATH || '/var/lib/quox/channel-conversations.db';

const VALID_CHANNEL_TYPES = new Set(['telegram', 'slack', 'discord']);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS channel_conversations (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_type         TEXT NOT NULL,
    external_id          TEXT NOT NULL,
    quox_conversation_id TEXT,
    org_id               TEXT,
    widget_id            TEXT,
    turns_json           TEXT,
    last_activity        INTEGER NOT NULL,
    created_at           INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_conversations_channel_external
    ON channel_conversations(channel_type, external_id);
`;

// Connections cached per resolved dbPath, same rationale as
// reflectionMiningWatermark.js: tests point at an isolated temp file
// without disturbing (or being disturbed by) the production default, and
// repeated calls within a process reuse one open handle.
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
      console.error(`[ChannelConversationStore] failed to open durable store at ${resolvedPath}, falling back to no-persistence behavior this process, ${err.message}`);
      _warnedPaths.add(resolvedPath);
    }
    _connections.set(resolvedPath, null); // cache the failure too, don't retry every call
    return null;
  }
}

function assertChannelType(channelType) {
  if (!VALID_CHANNEL_TYPES.has(channelType)) {
    throw new Error(`channelConversationStore: unknown channel_type "${channelType}"`);
  }
}

function deriveConversationId(channelType, externalId) {
  return `${channelType}_${externalId}`;
}

function rowToConversation(row) {
  if (!row) return null;
  let turns = [];
  if (row.turns_json) {
    try {
      const parsed = JSON.parse(row.turns_json);
      if (Array.isArray(parsed)) turns = parsed;
    } catch {
      turns = [];
    }
  }
  return { ...row, turns };
}

/**
 * Idempotent upsert of a channel thread's conversation row (turns +
 * bookkeeping columns). Unique on (channel_type, external_id): a second
 * upsert for the same thread updates the existing row rather than creating
 * a duplicate.
 *
 * @returns {boolean} true on a successful durable write, false if the store
 *   is unavailable or the write failed (callers must fall back to
 *   in-memory only; this function never throws).
 */
function upsertConversation({
  channel_type,
  external_id,
  turns,
  org_id = null,
  widget_id = null,
  quox_conversation_id = null,
  last_activity = null,
}, { dbPath } = {}) {
  assertChannelType(channel_type);
  if (!external_id && external_id !== 0) throw new Error('upsertConversation requires external_id');

  const db = resolveDb(dbPath);
  if (!db) return false;

  const externalIdStr = String(external_id);
  const now = last_activity || Date.now();
  const convId = quox_conversation_id || deriveConversationId(channel_type, externalIdStr);
  const turnsJson = JSON.stringify(Array.isArray(turns) ? turns : []);

  try {
    db.prepare(`
      INSERT INTO channel_conversations
        (channel_type, external_id, quox_conversation_id, org_id, widget_id, turns_json, last_activity, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_type, external_id) DO UPDATE SET
        turns_json           = excluded.turns_json,
        last_activity        = excluded.last_activity,
        quox_conversation_id = COALESCE(excluded.quox_conversation_id, channel_conversations.quox_conversation_id),
        org_id               = COALESCE(excluded.org_id, channel_conversations.org_id),
        widget_id            = COALESCE(excluded.widget_id, channel_conversations.widget_id)
    `).run(channel_type, externalIdStr, convId, org_id, widget_id, turnsJson, now, now);
    return true;
  } catch (err) {
    console.error(`[ChannelConversationStore] upsert failed for ${channel_type}:${externalIdStr}, ${err.message}`);
    return false;
  }
}

/**
 * Read back a single channel thread's durable row (turns already parsed).
 * Returns null if unknown or the store is unavailable.
 */
function getConversation(channel_type, external_id, { dbPath } = {}) {
  assertChannelType(channel_type);
  const db = resolveDb(dbPath);
  if (!db) return null;
  try {
    const row = db.prepare(
      'SELECT * FROM channel_conversations WHERE channel_type = ? AND external_id = ?'
    ).get(channel_type, String(external_id));
    return rowToConversation(row);
  } catch (err) {
    console.error(`[ChannelConversationStore] read failed for ${channel_type}:${external_id}, ${err.message}`);
    return null;
  }
}

/**
 * All durable rows for a channel type, most recently active first. Used for
 * boot-reseed: a fresh in-process cache (e.g. a new TelegramConversationStore
 * after a restart) loads recent threads back from here instead of starting
 * cold.
 */
function listByChannelType(channel_type, { dbPath, limit = 1000 } = {}) {
  assertChannelType(channel_type);
  const db = resolveDb(dbPath);
  if (!db) return [];
  try {
    const rows = db.prepare(
      'SELECT * FROM channel_conversations WHERE channel_type = ? ORDER BY last_activity DESC LIMIT ?'
    ).all(channel_type, limit);
    return rows.map(rowToConversation);
  } catch (err) {
    console.error(`[ChannelConversationStore] listByChannelType failed for ${channel_type}, ${err.message}`);
    return [];
  }
}

/**
 * Delete a channel thread's durable row (e.g. TTL expiry, explicit clear).
 */
function clearConversation(channel_type, external_id, { dbPath } = {}) {
  assertChannelType(channel_type);
  const db = resolveDb(dbPath);
  if (!db) return false;
  try {
    db.prepare('DELETE FROM channel_conversations WHERE channel_type = ? AND external_id = ?')
      .run(channel_type, String(external_id));
    return true;
  } catch (err) {
    console.error(`[ChannelConversationStore] clear failed for ${channel_type}:${external_id}, ${err.message}`);
    return false;
  }
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

module.exports = {
  upsertConversation,
  getConversation,
  listByChannelType,
  clearConversation,
  deriveConversationId,
  _closeForTest,
  DEFAULT_DB_PATH,
  VALID_CHANNEL_TYPES,
};
