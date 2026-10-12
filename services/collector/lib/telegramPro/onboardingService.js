/**
 * Telegram Pro Onboarding Service, QTG-PRO P0.
 *
 * Handler bodies for the plugin onboarding wizard's two collector endpoints
 * (GET .../onboarding/status, POST .../onboarding/bind-owner), factored out
 * of server.js so they are directly unit-testable. The Express routes in
 * server.js are thin wrappers around getOnboardingStatus() and bindOwner().
 *
 * Seen-chat rows themselves are recorded elsewhere (telegramWebhook.js on
 * every real inbound message, via threadRegistry.recordSeenChat) — this
 * module only reads that state plus the Telegram Bot API for status, and
 * writes an owner binding.
 */

'use strict';

const { getWebhookConfig } = require('../telegramWebhook');
const { getBotInfo, getWebhookInfo } = require('../../utils/telegramSetup');
const threadRegistry = require('./threadRegistry');
const bindingStore = require('./bindingStore');

const DEFAULT_BOT_ID = 'default';
const LOOKUP_CACHE_TTL_MS = 30_000;

function warn(context, err) {
  console.error(`[TelegramOnboarding] ${context}, ${err.message}`);
}

// Cached per botId so the wizard's ~4s status polling never hammers the
// Telegram Bot API (getMe / getWebhookInfo) on every request.
let _lookupCache = {};

function _clearCacheForTest() {
  _lookupCache = {};
}

/**
 * Resolves { bot, webhook } for a bot, cached 30s. Never leaks the bot
 * token: only username/first_name (bot) and url/active/last_error_message
 * (webhook) reach the caller. Both are null when no token is configured or
 * the Bot API call fails.
 */
async function getBotAndWebhookInfo({ botId = DEFAULT_BOT_ID, deps = {} } = {}) {
  const _getWebhookConfig = deps.getWebhookConfig || getWebhookConfig;
  const _getBotInfo = deps.getBotInfo || getBotInfo;
  const _getWebhookInfo = deps.getWebhookInfo || getWebhookInfo;

  const now = Date.now();
  const cached = _lookupCache[botId];
  if (cached && (now - cached.time) < LOOKUP_CACHE_TTL_MS) {
    return { bot: cached.bot, webhook: cached.webhook };
  }

  const config = await _getWebhookConfig(botId === DEFAULT_BOT_ID ? undefined : botId);
  const token = config?.bot_token;

  let bot = null;
  let webhook = null;

  if (token) {
    try {
      const info = await _getBotInfo(token);
      bot = { username: info?.username || null, name: info?.first_name || null };
    } catch (err) {
      warn('getBotInfo failed', err);
      bot = null;
    }

    try {
      const info = await _getWebhookInfo(token);
      webhook = {
        url: info?.url || '',
        active: !!info?.url,
        last_error_message: info?.last_error_message || null,
      };
    } catch (err) {
      warn('getWebhookInfo failed', err);
      webhook = null;
    }
  }

  _lookupCache[botId] = { bot, webhook, time: now };
  return { bot, webhook };
}

/**
 * GET /telegram-pro/onboarding/status handler body.
 *
 * botId parameterizes the single-bot fields (bot, webhook, chats_seen,
 * owner_binding), defaulting to 'default' so the original single-bot UI
 * shape keeps working unchanged. bots[] is the multi-bot roster: every
 * bot_id the collector has local evidence of, alongside the requested one.
 *
 * @returns {Promise<{bot: object|null, webhook: object|null, chats_seen: object[], owner_binding: object|null, bots: object[]}>}
 */
async function getOnboardingStatus({ botId = DEFAULT_BOT_ID, deps = {} } = {}) {
  const _listSeenChats = deps.listSeenChats || threadRegistry.listSeenChats;
  const _getBindingsByTarget = deps.getBindingsByTarget || bindingStore.getBindingsByTarget;
  const _listKnownBotIds = deps.listKnownBotIds || threadRegistry.listKnownBotIds;

  const { bot, webhook } = await getBotAndWebhookInfo({ botId, deps });

  const chatRows = _listSeenChats({ botId }) || [];
  const chats_seen = chatRows.map(row => ({
    tg_chat_id: row.tg_chat_id,
    title: row.title || null,
    chat_type: row.chat_type || null,
    is_forum: !!row.is_forum,
    seen_at: row.updated_at,
  }));

  // Owner binding is bot-scoped: a chat_id could in principle repeat across
  // different bots, so match on bot_id too, not just the first owner row.
  const ownerBindings = _getBindingsByTarget({ targetKind: 'owner', targetId: 'owner' }) || [];
  const ownerForThisBot = ownerBindings.find(b => b.bot_id === botId) || null;
  let owner_binding = null;
  if (ownerForThisBot) {
    const chatRow = chatRows.find(r => r.tg_chat_id === ownerForThisBot.tg_chat_id) || null;
    owner_binding = {
      tg_chat_id: ownerForThisBot.tg_chat_id,
      title: chatRow?.title || null,
    };
  }

  // bots[] roster (multi-bot rescope): every bot_id the collector has local
  // evidence of (a chat-level telegram_chats row) plus the requested/
  // default bot even with zero chats yet. There is no cheap "list
  // configured bot credentials" call on the auth service today, so this is
  // the best available enumeration — a freshly-added bot with a token but
  // no inbound messages yet will not appear until its first message.
  const knownBotIds = _listKnownBotIds() || [];
  const rosterIds = Array.from(new Set([botId, ...knownBotIds]));

  const bots = await Promise.all(rosterIds.map(async (id) => {
    const info = id === botId ? { bot, webhook } : await getBotAndWebhookInfo({ botId: id, deps });
    const rowsForBot = id === botId ? chatRows : (_listSeenChats({ botId: id }) || []);
    return {
      bot_id: id,
      username: info.bot?.username || null,
      name: info.bot?.name || null,
      kind: id === DEFAULT_BOT_ID ? 'gateway' : 'bot',
      webhook_active: !!info.webhook?.active,
      chats_bound: rowsForBot.length,
    };
  }));

  // A roster entry with no resolvable identity, no webhook, and no seen
  // chats is not a bot, it is the absence of one (nothing configured yet).
  // Including it would make a fresh install render a phantom "default"
  // row instead of the onboarding flow.
  const configuredBots = bots.filter(
    (b) => b.username || b.webhook_active || b.chats_bound > 0
  );

  return { bot, webhook, chats_seen, owner_binding, bots: configuredBots };
}

/**
 * POST /telegram-pro/onboarding/bind-owner handler body.
 * Validates the chat was actually seen before allowing the bind, rejects a
 * duplicate primary binding with the existing row (409 shape), and
 * best-effort creates an "Owner" forum topic when the chat is a forum —
 * a topic-creation failure never fails the bind itself.
 *
 * @returns {Promise<{status: number, body: object}>} status/body pair the
 *   server.js route wrapper writes straight through to the response.
 */
async function bindOwner({ botId = DEFAULT_BOT_ID, tgChatId, createdBy = null, deps = {} } = {}) {
  const _listSeenChats = deps.listSeenChats || threadRegistry.listSeenChats;
  const _createBinding = deps.createBinding || bindingStore.createBinding;
  const _getBindingForInbound = deps.getBindingForInbound || bindingStore.getBindingForInbound;
  const _ensureTopic = deps.ensureTopic || threadRegistry.ensureTopic;
  const _getWebhookConfig = deps.getWebhookConfig || getWebhookConfig;

  if (tgChatId === undefined || tgChatId === null || tgChatId === '') {
    return { status: 400, body: { error: 'tg_chat_id is required' } };
  }

  const chatIdStr = String(tgChatId);
  const chatRows = _listSeenChats({ botId }) || [];
  const chatRow = chatRows.find(r => r.tg_chat_id === chatIdStr);
  if (!chatRow) {
    return { status: 400, body: { error: 'chat has not been seen yet, message the bot from that chat first' } };
  }

  const binding = _createBinding({
    botId,
    tgChatId: chatIdStr,
    messageThreadId: null,
    targetKind: 'owner',
    targetId: 'owner',
    mode: 'primary',
    createdBy,
  });

  if (binding && binding.error) {
    if (binding.error === 'a primary binding already exists for this bot/chat/thread') {
      const existing = _getBindingForInbound({ botId, tgChatId: chatIdStr, messageThreadId: null });
      return { status: 409, body: { error: binding.error, binding: existing } };
    }
    return { status: 500, body: { error: binding.error } };
  }

  let owner_topic = null;
  if (chatRow.is_forum) {
    try {
      const config = await _getWebhookConfig(botId === DEFAULT_BOT_ID ? undefined : botId);
      owner_topic = await _ensureTopic({ token: config?.bot_token, botId, chatId: chatIdStr, name: 'Owner' });
    } catch (err) {
      warn('ensureTopic failed for owner binding', err);
      owner_topic = null;
    }
  }

  return { status: 200, body: { ok: true, binding, owner_topic } };
}

module.exports = {
  getOnboardingStatus,
  bindOwner,
  _clearCacheForTest,
};
