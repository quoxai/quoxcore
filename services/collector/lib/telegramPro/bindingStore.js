/**
 * Telegram Channel Binding Store, QTG-PRO P0.
 *
 * A binding maps a Telegram chat (optionally a specific forum topic within
 * it) to a Quox target: a session, an agent, a team, the HITL inbox, or the
 * owner. Exactly one 'primary' binding may exist per (bot_id, tg_chat_id,
 * message_thread_id), that's the default destination inbound messages
 * from that chat/topic resolve to. Non-primary bindings (mode values other
 * than 'primary', e.g. a future 'mirror' or 'watch' mode) are unconstrained
 * and may coexist alongside the primary one.
 */

'use strict';

const telegramProStore = require('./telegramProStore');

function warn(context, err) {
  console.error(`[TelegramBindingStore] ${context}, ${err.message}`);
}

function assertTargetKind(targetKind) {
  if (!telegramProStore.VALID_TARGET_KINDS.has(targetKind)) {
    throw new Error(`bindingStore: unknown target_kind "${targetKind}"`);
  }
}

function getBindingById(id, { dbPath } = {}) {
  const db = telegramProStore.getDb(dbPath);
  if (!db) return null;
  try {
    return db.prepare('SELECT * FROM channel_bindings WHERE id = ?').get(id) || null;
  } catch (err) {
    warn(`getBindingById failed for ${id}`, err);
    return null;
  }
}

/**
 * Creates a binding. If mode is 'primary' and a primary binding already
 * exists for the same (bot_id, tg_chat_id, message_thread_id), no row is
 * written and { error } is returned instead of throwing (this is an
 * expected, recoverable outcome for callers, not a store failure).
 *
 * @returns {object} the created binding row, or { error: string }.
 */
function createBinding({
  orgId = null,
  botId,
  tgChatId,
  messageThreadId = null,
  targetKind,
  targetId = null,
  mode = 'primary',
  replyRoutingJson = null,
  createdBy = null,
  dbPath,
} = {}) {
  assertTargetKind(targetKind);
  if (!botId) throw new Error('createBinding requires botId');
  if (!tgChatId && tgChatId !== 0) throw new Error('createBinding requires tgChatId');

  const db = telegramProStore.getDb(dbPath);
  if (!db) return { error: 'store unavailable' };

  try {
    if (mode === 'primary') {
      const whereThread = messageThreadId === null || messageThreadId === undefined
        ? '(message_thread_id IS NULL)'
        : '(message_thread_id = ?)';
      const params = messageThreadId === null || messageThreadId === undefined
        ? [botId, String(tgChatId)]
        : [botId, String(tgChatId), messageThreadId];
      const existing = db.prepare(
        `SELECT id FROM channel_bindings WHERE bot_id = ? AND tg_chat_id = ? AND ${whereThread} AND mode = 'primary'`
      ).get(...params);
      if (existing) {
        return { error: 'a primary binding already exists for this bot/chat/thread' };
      }
    }

    const now = Date.now();
    const info = db.prepare(`
      INSERT INTO channel_bindings
        (org_id, provider, bot_id, tg_chat_id, message_thread_id, target_kind, target_id, mode, reply_routing_json, created_by, created_at)
      VALUES (?, 'telegram', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orgId, botId, String(tgChatId), messageThreadId, targetKind, targetId, mode, replyRoutingJson, createdBy, now);

    return getBindingById(info.lastInsertRowid, { dbPath });
  } catch (err) {
    // Catches the partial unique index too, in case of a race between the
    // explicit check above and the insert (belt and braces, single-writer
    // better-sqlite3 makes this a non-issue in practice).
    warn(`createBinding failed for ${botId}:${tgChatId}:${messageThreadId}`, err);
    return { error: err.message };
  }
}

/**
 * Resolves the primary binding an inbound message should route to: an
 * exact (bot, chat, thread) match first, falling back to the chat-level
 * binding (message_thread_id IS NULL) if no topic-specific binding exists.
 * Returns null if neither exists or the store is unavailable.
 */
function getBindingForInbound({ botId, tgChatId, messageThreadId = null, dbPath } = {}) {
  const db = telegramProStore.getDb(dbPath);
  if (!db) return null;

  try {
    if (messageThreadId !== null && messageThreadId !== undefined) {
      const exact = db.prepare(`
        SELECT * FROM channel_bindings
        WHERE bot_id = ? AND tg_chat_id = ? AND message_thread_id = ? AND mode = 'primary'
      `).get(botId, String(tgChatId), messageThreadId);
      if (exact) return exact;
    }

    const chatLevel = db.prepare(`
      SELECT * FROM channel_bindings
      WHERE bot_id = ? AND tg_chat_id = ? AND message_thread_id IS NULL AND mode = 'primary'
    `).get(botId, String(tgChatId));

    return chatLevel || null;
  } catch (err) {
    warn(`getBindingForInbound failed for ${botId}:${tgChatId}:${messageThreadId}`, err);
    return null;
  }
}

/** All bindings pointing at a given target (session, agent, team, ...). */
function getBindingsByTarget({ targetKind, targetId, dbPath } = {}) {
  const db = telegramProStore.getDb(dbPath);
  if (!db) return [];
  try {
    return db.prepare(
      'SELECT * FROM channel_bindings WHERE target_kind = ? AND target_id = ? ORDER BY created_at DESC'
    ).all(targetKind, targetId);
  } catch (err) {
    warn(`getBindingsByTarget failed for ${targetKind}:${targetId}`, err);
    return [];
  }
}

/** All bindings, optionally scoped to a single org. */
function listBindings({ orgId, dbPath } = {}) {
  const db = telegramProStore.getDb(dbPath);
  if (!db) return [];
  try {
    if (orgId) {
      return db.prepare('SELECT * FROM channel_bindings WHERE org_id = ? ORDER BY created_at DESC').all(orgId);
    }
    return db.prepare('SELECT * FROM channel_bindings ORDER BY created_at DESC').all();
  } catch (err) {
    warn('listBindings failed', err);
    return [];
  }
}

/** Deletes a binding by id. Returns true on success, false otherwise. */
function deleteBinding({ id, dbPath } = {}) {
  const db = telegramProStore.getDb(dbPath);
  if (!db) return false;
  try {
    db.prepare('DELETE FROM channel_bindings WHERE id = ?').run(id);
    return true;
  } catch (err) {
    warn(`deleteBinding failed for ${id}`, err);
    return false;
  }
}

module.exports = {
  createBinding,
  getBindingForInbound,
  getBindingsByTarget,
  listBindings,
  deleteBinding,
};
