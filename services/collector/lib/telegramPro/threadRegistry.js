/**
 * Telegram Forum Topic Registry, QTG-PRO P0.
 *
 * Tracks forum topics (Telegram's "threads" inside a supergroup with Topics
 * enabled) over the telegram_chats table owned by telegramProStore.js.
 * A row with message_thread_id = NULL represents the chat itself (or, for
 * a forum-enabled chat, its built-in General topic); a row with a non-null
 * message_thread_id is a specific forum topic.
 *
 * General topic special case: Telegram does not allow General to be
 * created or queried via the Bot API's *ForumTopic methods (getForumTopic
 * does not exist at all, and createForumTopic will error if you try to
 * recreate it). We never store a row for General and represent it in code
 * as threadKey = null. threadParam() below is the single place that turns
 * a threadKey into the outbound API params, so every send path omits
 * message_thread_id entirely for General instead of sending 1 (a common,
 * incorrect assumption; General's internal thread id is not guaranteed to
 * be 1 and the field must be absent, not zero or one, when targeting it).
 */

'use strict';

const telegramProStore = require('./telegramProStore');

function warn(context, err) {
  console.error(`[TelegramThreadRegistry] ${context}, ${err.message}`);
}

function rowMatchesThread(threadId) {
  return threadId === null || threadId === undefined
    ? '(message_thread_id IS NULL)'
    : '(message_thread_id = ?)';
}

/**
 * Insert-or-update a single telegram_chats row, keyed on
 * (bot_id, tg_chat_id, message_thread_id). Implemented as an explicit
 * select-then-write rather than ON CONFLICT because SQLite treats every
 * NULL in a UNIQUE index as distinct, so ON CONFLICT never fires for the
 * message_thread_id IS NULL (chat-level) row.
 */
function upsertTopicRow({ botId, chatId, threadId = null, patch = {}, dbPath }) {
  const db = telegramProStore.getDb(dbPath);
  if (!db) return null;

  const now = Date.now();

  try {
    const whereThread = rowMatchesThread(threadId);
    const params = threadId === null || threadId === undefined
      ? [botId, String(chatId)]
      : [botId, String(chatId), threadId];

    const existing = db.prepare(
      `SELECT * FROM telegram_chats WHERE bot_id = ? AND tg_chat_id = ? AND ${whereThread}`
    ).get(...params);

    if (existing) {
      const merged = { ...existing, ...patch, updated_at: now };
      db.prepare(`
        UPDATE telegram_chats SET
          org_id = ?, chat_type = ?, is_forum = ?, title = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(
        merged.org_id ?? null,
        merged.chat_type ?? null,
        merged.is_forum ?? 0,
        merged.title ?? null,
        merged.status ?? 'active',
        now,
        existing.id
      );
      return db.prepare('SELECT * FROM telegram_chats WHERE id = ?').get(existing.id);
    }

    const info = db.prepare(`
      INSERT INTO telegram_chats
        (org_id, bot_id, tg_chat_id, chat_type, is_forum, message_thread_id, title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      patch.org_id ?? null,
      botId,
      String(chatId),
      patch.chat_type ?? null,
      patch.is_forum ?? 0,
      threadId,
      patch.title ?? null,
      patch.status ?? 'active',
      now,
      now
    );
    return db.prepare('SELECT * FROM telegram_chats WHERE id = ?').get(info.lastInsertRowid);
  } catch (err) {
    warn(`upsertTopicRow failed for ${botId}:${chatId}:${threadId}`, err);
    return null;
  }
}

/**
 * Handles a Telegram forum service message and upserts the corresponding
 * telegram_chats row. Recognized service message shapes:
 *   forum_topic_created  { name }         -> creates the topic row (active)
 *   forum_topic_edited   { name? }        -> renames if name present
 *   forum_topic_closed   {}               -> status = closed
 *   forum_topic_reopened {}               -> status = active
 *
 * @returns {object|null} the resulting telegram_chats row, or null if the
 *   message was not a recognized forum service message, or the write failed.
 */
function recordServiceMessage({ botId, chatId, msg, dbPath } = {}) {
  if (!botId) throw new Error('recordServiceMessage requires botId');
  if (!chatId && chatId !== 0) throw new Error('recordServiceMessage requires chatId');
  if (!msg) return null;

  const threadId = msg.message_thread_id ?? null;

  if (msg.forum_topic_created) {
    return upsertTopicRow({
      botId,
      chatId,
      threadId,
      patch: {
        title: msg.forum_topic_created.name,
        status: 'active',
        is_forum: 1,
      },
      dbPath,
    });
  }

  if (msg.forum_topic_edited) {
    const patch = { is_forum: 1 };
    if (msg.forum_topic_edited.name) patch.title = msg.forum_topic_edited.name;
    return upsertTopicRow({ botId, chatId, threadId, patch, dbPath });
  }

  if (msg.forum_topic_closed) {
    return upsertTopicRow({ botId, chatId, threadId, patch: { status: 'closed', is_forum: 1 }, dbPath });
  }

  if (msg.forum_topic_reopened) {
    return upsertTopicRow({ botId, chatId, threadId, patch: { status: 'active', is_forum: 1 }, dbPath });
  }

  return null;
}

/**
 * Looks up a topic row by title. Not status-filtered: callers that only
 * want live topics (e.g. ensureTopic) check `.status === 'active'`
 * themselves. Returns null if not found or the store is unavailable.
 */
function getTopicByName({ botId, chatId, name, dbPath } = {}) {
  const db = telegramProStore.getDb(dbPath);
  if (!db) return null;
  try {
    return db.prepare(`
      SELECT * FROM telegram_chats
      WHERE bot_id = ? AND tg_chat_id = ? AND title = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(botId, String(chatId), name) || null;
  } catch (err) {
    warn(`getTopicByName failed for ${botId}:${chatId}:${name}`, err);
    return null;
  }
}

/**
 * Looks up a topic row by exact thread id. threadId = null resolves the
 * chat-level row (never the General topic, which is not stored, see
 * module docstring).
 */
function getTopic({ botId, chatId, threadId = null, dbPath } = {}) {
  const db = telegramProStore.getDb(dbPath);
  if (!db) return null;
  try {
    const whereThread = rowMatchesThread(threadId);
    const params = threadId === null || threadId === undefined
      ? [botId, String(chatId)]
      : [botId, String(chatId), threadId];
    return db.prepare(
      `SELECT * FROM telegram_chats WHERE bot_id = ? AND tg_chat_id = ? AND ${whereThread}`
    ).get(...params) || null;
  } catch (err) {
    warn(`getTopic failed for ${botId}:${chatId}:${threadId}`, err);
    return null;
  }
}

/**
 * Insert-or-update the chat-level telegram_chats row (message_thread_id
 * NULL) for a bot/chat pair, QTG-PRO P0 onboarding wizard. Called from
 * telegramWebhook.js on every real inbound message so the wizard can show
 * "chats seen" without a separate registration step. title is only written
 * when given (icon/type-only updates never blank out a previously seen
 * title). Fail-soft via upsertTopicRow, never throws to the caller except
 * on a missing required argument.
 */
function recordSeenChat({ botId, chatId, chatType, isForum, title, dbPath } = {}) {
  if (!botId) throw new Error('recordSeenChat requires botId');
  if (!chatId && chatId !== 0) throw new Error('recordSeenChat requires chatId');

  const patch = {
    chat_type: chatType ?? null,
    is_forum: isForum ? 1 : 0,
  };
  if (title) patch.title = title;

  return upsertTopicRow({ botId, chatId, threadId: null, patch, dbPath });
}

/**
 * Lists chat-level (message_thread_id IS NULL) telegram_chats rows for a
 * bot, QTG-PRO P0 onboarding wizard's "chats seen" list. Forum topic rows
 * are excluded by construction. Returns [] if the store is unavailable.
 */
function listSeenChats({ botId, dbPath } = {}) {
  const db = telegramProStore.getDb(dbPath);
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT * FROM telegram_chats
      WHERE bot_id = ? AND message_thread_id IS NULL
      ORDER BY updated_at DESC
    `).all(botId);
  } catch (err) {
    warn(`listSeenChats failed for ${botId}`, err);
    return [];
  }
}

/**
 * Distinct bot_ids the collector has local evidence of, QTG-PRO P0
 * multi-bot roster status. Derived from chat-level telegram_chats rows
 * (every bot that has recorded a seen chat appears here) rather than a
 * remote enumeration call, since the auth service has no "list configured
 * bots" endpoint today. Cheap: single indexed DISTINCT query. Returns []
 * if the store is unavailable.
 */
function listKnownBotIds({ dbPath } = {}) {
  const db = telegramProStore.getDb(dbPath);
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT DISTINCT bot_id FROM telegram_chats
      WHERE message_thread_id IS NULL
      ORDER BY bot_id
    `).all().map(row => row.bot_id);
  } catch (err) {
    warn('listKnownBotIds failed', err);
    return [];
  }
}

/**
 * Real Telegram Bot API caller, used when ensureTopic is not given an
 * injected `api` function (tests always inject one).
 */
function buildDefaultApi(token) {
  return async function callTelegramApi(method, params) {
    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    if (!data.ok) {
      throw new Error(`Telegram API ${method} failed: ${data.description || resp.status}`);
    }
    return data.result;
  };
}

/**
 * Returns the existing active topic by name, or creates one via
 * createForumTopic and records it. Requires the bot to be an admin with
 * can_manage_topics for the chat (a Telegram-side precondition this
 * function cannot verify; createForumTopic will reject otherwise).
 *
 * @returns {Promise<{threadId: number, created: boolean}>}
 */
async function ensureTopic({ token, botId, chatId, name, dbPath, api } = {}) {
  if (!botId) throw new Error('ensureTopic requires botId');
  if (!chatId && chatId !== 0) throw new Error('ensureTopic requires chatId');
  if (!name) throw new Error('ensureTopic requires name');

  const existing = getTopicByName({ botId, chatId, name, dbPath });
  if (existing && existing.status === 'active' && existing.message_thread_id !== null) {
    return { threadId: existing.message_thread_id, created: false };
  }

  const callApi = api || buildDefaultApi(token);
  const result = await callApi('createForumTopic', { chat_id: chatId, name });
  const threadId = result && result.message_thread_id;
  if (threadId === undefined || threadId === null) {
    throw new Error('createForumTopic response missing message_thread_id');
  }

  upsertTopicRow({
    botId,
    chatId,
    threadId,
    patch: { title: name, status: 'active', is_forum: 1 },
    dbPath,
  });

  return { threadId, created: true };
}

/**
 * threadKey -> outbound Telegram API params. null/undefined (General, or
 * the chat itself) must omit message_thread_id entirely, never send it as
 * 1 or 0.
 */
function threadParam(threadKey) {
  if (threadKey === null || threadKey === undefined) return {};
  return { message_thread_id: threadKey };
}

module.exports = {
  recordServiceMessage,
  recordSeenChat,
  listSeenChats,
  listKnownBotIds,
  getTopicByName,
  getTopic,
  ensureTopic,
  threadParam,
};
