/**
 * Telegram Pro Owner Channel, QTG-PRO P0 cutover prep.
 *
 * sendToOwner() is the outbound send the TG_BACKEND=botapi shim path calls
 * to reach the owner directly over the Telegram Bot API, replacing the
 * Matrix double-puppet mirror (tg-send.sh's "🤖 [SESSION-NAME] message"
 * prefix convention, kept identical here so the owner sees the same shape
 * regardless of which backend is armed).
 *
 * Never throws: every expected failure (no owner binding, no bot token)
 * resolves to { ok: false, error } so the calling shim can fall back to the
 * Matrix path instead of crashing. Sends are routed through the shared
 * outbound queue (lane pacing, digest degradation, 429 handling) exactly
 * like the webhook reply path, never a direct fetch to the Bot API.
 */

'use strict';

const { getWebhookConfig } = require('../telegramWebhook');
const bindingStore = require('./bindingStore');
const threadRegistry = require('./threadRegistry');
const { getSharedQueue } = require('./queueSingleton');

const DEFAULT_BOT_ID = 'default';
const OWNER_TOPIC_NAME = 'Owner';

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Resolves the primary owner binding for a bot. bindingStore.getBindingsByTarget
 * returns every 'owner' binding across all bots; when more than one exists
 * (multi-bot roster) it is filtered down to the one matching botId. With
 * zero or one binding present, no bot_id filter is applied.
 */
function resolveOwnerBinding(bindings, botId) {
  if (!bindings || bindings.length === 0) return null;
  if (bindings.length > 1) {
    return bindings.find((b) => b.bot_id === botId) || null;
  }
  return bindings[0];
}

/**
 * Sends a message to the owner's bound Telegram chat, targeting the
 * "Owner" forum topic when one has been recorded for that chat, otherwise
 * the chat itself (General topic, message_thread_id omitted).
 *
 * @param {object} params
 * @param {string} params.text - message body.
 * @param {string} [params.sessionName] - rendered as a bold "[NAME] " prefix,
 *   mirroring the Matrix shim's "🤖 [SESSION-NAME] message" convention.
 * @param {string} [params.botId='default']
 * @param {boolean} [params.escaped=false] - true if `text` is already
 *   safe HTML and must not be escaped again (mirrors outboundQueue.send's
 *   own `escaped` flag).
 * @param {object} [params.deps] - test seams; each defaults to the real module fn.
 * @returns {Promise<{ok: true, messageId, chatId, threadKey} | {ok: false, error: string}>}
 */
async function sendToOwner({
  text,
  sessionName,
  botId = DEFAULT_BOT_ID,
  escaped = false,
  deps = {},
} = {}) {
  const _getBindingsByTarget = deps.getBindingsByTarget || bindingStore.getBindingsByTarget;
  const _getWebhookConfig = deps.getWebhookConfig || getWebhookConfig;
  const _getTopicByName = deps.getTopicByName || threadRegistry.getTopicByName;
  const _getSharedQueue = deps.getSharedQueue || getSharedQueue;

  const bindings = _getBindingsByTarget({ targetKind: 'owner', targetId: 'owner' }) || [];
  const binding = resolveOwnerBinding(bindings, botId);
  if (!binding) {
    return { ok: false, error: 'no_owner_binding' };
  }

  const config = await _getWebhookConfig(botId === DEFAULT_BOT_ID ? undefined : botId);
  const token = config?.bot_token;
  if (!token) {
    return { ok: false, error: 'no_token' };
  }

  const topic = _getTopicByName({ botId, chatId: binding.tg_chat_id, name: OWNER_TOPIC_NAME });
  const threadKey = (topic && topic.status === 'active' && topic.message_thread_id !== null && topic.message_thread_id !== undefined)
    ? topic.message_thread_id
    : null;

  const bodyHtml = escaped ? text : escapeHtml(text);
  const prefix = sessionName ? `<b>[${escapeHtml(sessionName)}]</b> ` : '';
  const html = `${prefix}${bodyHtml}`;

  try {
    const queue = _getSharedQueue();
    const result = await queue.send({
      botId,
      token,
      chatId: binding.tg_chat_id,
      threadKey,
      text: html,
      escaped: true,
    });
    return {
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
      threadKey: result.threadKey,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  sendToOwner,
};
