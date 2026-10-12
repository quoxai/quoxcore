/**
 * Telegram Outbound Queue Singleton, QTG-PRO P0.
 *
 * The webhook handler and any future sendReply-through-the-queue callers
 * need to share one outboundQueue instance per process so lane pacing and
 * digest state are actually shared (a fresh queue per call would defeat the
 * whole point of the coalescing lanes). Lazily created on first use so
 * requiring this module has no side effects, and every persisted send is
 * written into telegramProStore's outbound_message_refs table.
 */

'use strict';

const { createQueue } = require('./outboundQueue');
const telegramProStore = require('./telegramProStore');

let _queue = null;

function persistRef({ botId, tgChatId, messageThreadId, messageId, kind }) {
  const db = telegramProStore.getDb();
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO outbound_message_refs
        (bot_id, tg_chat_id, message_thread_id, message_id, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(botId ?? null, tgChatId != null ? String(tgChatId) : null, messageThreadId ?? null, messageId ?? null, kind ?? null, Date.now());
  } catch (err) {
    console.error(`[TelegramQueueSingleton] persistRef failed, ${err.message}`);
  }
}

/**
 * Returns the process-wide outbound queue, creating it on first call.
 */
function getSharedQueue() {
  if (!_queue) {
    _queue = createQueue({ persistRef });
  }
  return _queue;
}

/**
 * Test-only escape hatch: drop the cached singleton so a test can get a
 * fresh queue (and reset lane state) without it leaking across test files.
 */
function _resetForTest() {
  _queue = null;
}

module.exports = { getSharedQueue, _resetForTest };
