/**
 * Telegram Inbound Webhook Handler
 *
 * Receives Telegram Bot API updates, resolves the sender to a Quox user,
 * routes messages through the /chat/claude pipeline, and sends replies
 * back via Telegram. Unknown senders get an inbox item for org admins.
 *
 * All config (bot token, webhook secret, org, bot username) is resolved
 * from QuoxVault / instance_config via the auth service — no env vars needed.
 *
 * AEE audit envelopes logged for all inbound/outbound messages.
 */

const fs = require('fs');
const path = require('path');

const { TelegramConversationStore } = require('./telegramConversationStore');
const { sendTelegram } = require('./notificationService');
const updateDedup = require('./telegramPro/updateDedup');
const threadRegistry = require('./telegramPro/threadRegistry');
const bindingStore = require('./telegramPro/bindingStore');
const { getSharedQueue } = require('./telegramPro/queueSingleton');
const configResolver = require('./configResolver.js');

// Conversation store — shared across requests
const conversationStore = new TelegramConversationStore();

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;
const COLLECTOR_PORT = process.env.COLLECTOR_PORT || 9848;
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const MAX_REPLY_LENGTH = 4000; // Telegram message limit
const TG_SESSION_INBOX_DIR = process.env.TG_SESSION_INBOX_DIR || '/tmp/claude-sessions';

// ============================================================================
// Webhook Config — resolved from auth service, cached with TTL
// ============================================================================

let _configCache = {};     // keyed by botId (or '_default')
let _configCacheTime = {};  // keyed by botId (or '_default')
const CONFIG_CACHE_TTL = 30_000; // 30 seconds, matches vault cache

/**
 * Fetch webhook config from auth service (vault + instance_config).
 * Cached for 30s per botId. Returns:
 *   { bot_token, webhook_secret, bot_username, default_org_id, default_agent }
 *
 * @param {string} [botId] - Optional bot credential ID for multi-bot routing
 */
async function getWebhookConfig(botId) {
  const cacheKey = botId || '_default';
  const now = Date.now();
  if (_configCache[cacheKey] && (now - _configCacheTime[cacheKey]) < CONFIG_CACHE_TTL) {
    return _configCache[cacheKey];
  }

  try {
    let url = `${AUTH_BASE_URL}/api/internal/telegram-webhook-config`;
    if (botId) url += `?bot_id=${encodeURIComponent(botId)}`;
    const resp = await fetch(url, {
      headers: INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (resp.ok) {
      _configCache[cacheKey] = await resp.json();
      _configCacheTime[cacheKey] = now;
      return _configCache[cacheKey];
    }
  } catch (err) {
    console.warn('[Telegram] Config fetch failed:', err.message);
  }

  // Fallback: return cached even if stale, or env-based defaults
  if (_configCache[cacheKey]) return _configCache[cacheKey];

  // VAULT-INTEG P17: bot_username/default_agent were bare process.env reads
  // — now resolved via configResolver.getInstanceSetting() (platformCapabilities.js
  // TELEGRAM_BOT_USERNAME / TELEGRAM_DEFAULT_AGENT). No org is known yet at
  // this point (this branch only runs when the vault-first, per-bot lookup
  // above is unreachable), so this is instance-scoped, not org-scoped.
  return {
    bot_token: process.env.NOTIFICATION_TELEGRAM_TOKEN || '',
    webhook_secret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    bot_username: configResolver.getInstanceSetting('TELEGRAM_BOT_USERNAME').value || '',
    default_org_id: process.env.DEFAULT_ORG_ID || '',
    default_agent: configResolver.getInstanceSetting('TELEGRAM_DEFAULT_AGENT').value || 'quox',
    has_token: !!process.env.NOTIFICATION_TELEGRAM_TOKEN
  };
}

/** Clear config cache (used after setup changes) */
function clearConfigCache() {
  _configCache = {};
  _configCacheTime = {};
}

// ============================================================================
// Message Parsing
// ============================================================================

/**
 * Parse a Telegram Update object into a normalized message.
 * @param {object} body - raw Telegram update
 * @returns {object|null} parsed message or null if not actionable
 */
function parseUpdate(body) {
  const msg = body.message || body.edited_message;
  if (!msg) return null;

  const chatId = msg.chat?.id;
  const text = msg.text || '';
  const fromId = msg.from?.id;
  const fromUsername = msg.from?.username || '';
  const fromFirstName = msg.from?.first_name || '';
  const chatType = msg.chat?.type || 'private'; // private, group, supergroup
  // QTG-PRO P0 onboarding: title comes from the chat's own title (groups,
  // supergroups, channels) or first_name (private chats, the other party).
  const chatTitle = msg.chat?.title || msg.chat?.first_name || '';

  // Command detection
  const isCommand = text.startsWith('/');
  const command = isCommand ? text.split(/\s+/)[0].split('@')[0].toLowerCase() : null;

  // Check for non-text content
  const isNonText = !text && !!(msg.photo || msg.document || msg.video || msg.audio || msg.voice || msg.sticker || msg.location);

  // Forum topics (QTG-PRO): the topic a message belongs to, and whether this
  // update is itself a topic-management service message (never chat).
  const messageThreadId = msg.message_thread_id ?? null;
  const isTopicMessage = !!msg.is_topic_message;
  const isForum = !!msg.chat?.is_forum;

  let forumEvent = null;
  if (msg.forum_topic_created) {
    forumEvent = { kind: 'forum_topic_created', name: msg.forum_topic_created.name, threadId: msg.message_thread_id };
  } else if (msg.forum_topic_edited) {
    forumEvent = { kind: 'forum_topic_edited', name: msg.forum_topic_edited.name, threadId: msg.message_thread_id };
  } else if (msg.forum_topic_closed) {
    forumEvent = { kind: 'forum_topic_closed', threadId: msg.message_thread_id };
  } else if (msg.forum_topic_reopened) {
    forumEvent = { kind: 'forum_topic_reopened', threadId: msg.message_thread_id };
  }

  return {
    chatId,
    text,
    fromId,
    fromUsername,
    fromFirstName,
    chatType,
    chatTitle,
    isCommand,
    command,
    isNonText,
    isEdited: !!body.edited_message,
    messageId: msg.message_id,
    entities: msg.entities || [],
    messageThreadId,
    isTopicMessage,
    isForum,
    forumEvent
  };
}

/**
 * Check if bot is mentioned in a group message (via @botusername entity).
 */
function isBotMentioned(parsed, botUsername) {
  if (!botUsername || parsed.chatType === 'private') return true;
  if (parsed.isCommand) return true;
  return parsed.entities.some(e =>
    e.type === 'mention' && parsed.text.substring(e.offset, e.offset + e.length).toLowerCase() === `@${botUsername.toLowerCase()}`
  );
}

// ============================================================================
// User Resolution & Routing
// ============================================================================

/**
 * Resolve Telegram chat_id to Quox user via auth service.
 */
async function resolveUser(chatId) {
  try {
    const resp = await fetch(`${AUTH_BASE_URL}/api/internal/telegram-user-lookup?chat_id=${encodeURIComponent(chatId)}`, {
      headers: INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (resp.ok) {
      const data = await resp.json();
      return data.user || null; // { user_id, org_id, display_name }
    }
  } catch (err) {
    console.error('[Telegram] User lookup failed:', err.message);
  }
  return null;
}

/**
 * Route message through /chat/claude pipeline with service-key auth.
 */
async function routeToChatPipeline(orgId, userId, prompt, chatId, defaultAgent) {
  const history = conversationStore.getHistory(chatId);

  const body = {
    prompt,
    selected_agent: defaultAgent || 'quox',
    session_id: `telegram_${chatId}`,
    conversation_history: history,
    org_id: orgId,
    user_id: userId,
    // CONCIERGE #437 P1: explicit surface awareness — lets the agent answer
    // "where are you right now" with the real surface instead of guessing
    // from the telegram_ session prefix. Covers webhook AND polling paths
    // (pollingManager reuses this dispatch).
    origin: { surface: 'telegram', channel_ref: String(chatId) }
  };

  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_SERVICE_KEY) {
    headers['X-Service-Key'] = INTERNAL_SERVICE_KEY;
  }

  const resp = await fetch(`http://127.0.0.1:${COLLECTOR_PORT}/chat/claude`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Chat pipeline returned ${resp.status}: ${errText.substring(0, 200)}`);
  }

  return resp.json();
}

/**
 * Create inbox item for unknown Telegram user.
 */
async function createInboxItem(chatId, fromUsername, fromFirstName, text, orgId) {
  if (!orgId) {
    console.warn('[Telegram] No org_id available — cannot create inbox item for unknown user');
    return;
  }

  try {
    await fetch(`${AUTH_BASE_URL}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {})
      },
      body: JSON.stringify({
        kind: 'info',
        priority: 'normal',
        title: `Telegram message from ${fromFirstName || fromUsername || chatId}`,
        body_md: `**From:** ${fromFirstName} (@${fromUsername || 'unknown'})\n**Chat ID:** ${chatId}\n\n${text.substring(0, 1000)}`,
        payload: { source: 'telegram', chat_id: chatId, from_username: fromUsername, from_name: fromFirstName }
      }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    console.error('[Telegram] Failed to create inbox item:', err.message);
  }
}

/**
 * Send reply back to Telegram, truncating if needed.
 * @param {string|number} chatId - Telegram chat ID
 * @param {string} text - Reply text
 * @param {string} [orgId] - Org ID for org-scoped bot token resolution
 * @param {number|null} [threadKey] - Forum topic to reply into, omitted for General/non-forum chats
 */
async function sendReply(chatId, text, orgId, threadKey) {
  const truncated = text.length > MAX_REPLY_LENGTH
    ? text.substring(0, MAX_REPLY_LENGTH - 3) + '...'
    : text;
  return sendTelegram(chatId, null, truncated, orgId, threadKey != null ? { threadKey } : {});
}

/**
 * Builds the arg list for a sendReply call, only appending the threadKey
 * arg when one is actually present so private/non-forum callers (and their
 * existing test assertions) keep seeing the legacy 3-arg call shape.
 */
function replyArgs(chatId, text, orgId, threadKey) {
  return threadKey === null || threadKey === undefined
    ? [chatId, text, orgId]
    : [chatId, text, orgId, threadKey];
}

/**
 * Appends one inbound line to the per-terminal Telegram inbox stream a host
 * watcher tails (QTG-PRO P0 session-binding routing). Fails soft: a
 * filesystem error here must never break the webhook.
 */
function appendSessionInbox(terminal, { chatId, threadId, from, text } = {}) {
  try {
    if (!fs.existsSync(TG_SESSION_INBOX_DIR)) {
      fs.mkdirSync(TG_SESSION_INBOX_DIR, { recursive: true });
    }
    const line = JSON.stringify({
      ts: Date.now(),
      terminal,
      chat_id: chatId,
      thread_id: threadId ?? null,
      from: from || '',
      text: text || ''
    });
    fs.appendFileSync(path.join(TG_SESSION_INBOX_DIR, `tg-inbox-${terminal}.jsonl`), line + '\n');
  } catch (err) {
    console.error('[Telegram] appendSessionInbox failed:', err.message);
  }
}

// ============================================================================
// Per-Update Processing Core (QTG-PRO polling)
// ============================================================================

/**
 * Processes a single raw Telegram update: replay dedup, parsing, seen-chat
 * recording, forum service-message registry sync, binding-aware routing,
 * group mention filtering, commands, and agent-pipeline routing.
 *
 * This is the shared core both ingestion paths call: the webhook handler
 * below (one update per HTTP request) and the long-poll worker in
 * lib/telegramPro/pollingManager.js (a batch of updates per getUpdates
 * call). Dedup runs first and unconditionally here, so at-least-once
 * delivery from either path (webhook retries, or polling re-delivering an
 * update after a restart before the offset was persisted) is always safe.
 *
 * @param {object} update - raw Telegram update object
 * @param {object} [ctx]
 * @param {string} [ctx.botId] - bot credential id (multi-bot routing)
 * @param {object} [ctx.config] - resolved config for this bot (bot_username,
 *   default_org_id, default_agent, org_id)
 * @param {object} [ctx.deps] - injectable dependencies, same shape
 *   handleTelegramWebhook accepts (seenBefore, recordServiceMessage,
 *   recordSeenChat, getBindingForInbound, resolveUser, routeToChatPipeline,
 *   createInboxItem, sendReply, storeAuditEnvelope, notifyInbound,
 *   appendSessionInbox), plus an optional ackResponse(body) callback the
 *   webhook handler uses to send its immediate 200 without this function
 *   needing to know about Express at all.
 * @returns {Promise<{ok: boolean, deduped?: boolean}>}
 */
async function processTelegramUpdate(update, ctx = {}) {
  const { botId, config = {}, deps = {} } = ctx;

  // Injected dependencies (for testing)
  const _storeAuditEnvelope = deps.storeAuditEnvelope || (() => {});
  const _resolveUser = deps.resolveUser || resolveUser;
  const _routeToChatPipeline = deps.routeToChatPipeline || routeToChatPipeline;
  const _createInboxItem = deps.createInboxItem || createInboxItem;
  const _sendReply = deps.sendReply || sendReply;
  const _seenBefore = deps.seenBefore || updateDedup.seenBefore;
  const _recordServiceMessage = deps.recordServiceMessage || threadRegistry.recordServiceMessage;
  const _recordSeenChat = deps.recordSeenChat || threadRegistry.recordSeenChat;
  const _getBindingForInbound = deps.getBindingForInbound || bindingStore.getBindingForInbound;
  const _notifyInbound = deps.notifyInbound || ((chatId, threadKey) => getSharedQueue().notifyInbound(chatId, threadKey));
  const _appendSessionInbox = deps.appendSessionInbox || appendSessionInbox;
  const _ackResponse = deps.ackResponse || (() => {});

  // 1. Replay dedup. Telegram retries webhook delivery on any non-200
  // response, and polling is at-least-once by construction (an update can
  // be re-delivered after a restart before its offset is persisted), so a
  // replayed update_id is a normal occurrence, not an edge case. Drop it
  // inert rather than reprocessing (and re-replying to) it.
  if (typeof update?.update_id === 'number') {
    if (_seenBefore({ botId: botId || 'default', updateId: update.update_id })) {
      _ackResponse({ ok: true, deduped: true });
      return { ok: true, deduped: true };
    }
  }

  // 2. Parse update
  const parsed = parseUpdate(update);
  if (!parsed || !parsed.chatId) {
    _ackResponse({ ok: true }); // Ignore non-message updates
    return { ok: true };
  }

  // 3. Ack immediately (webhook callers need a fast response; the poller's
  // default no-op ackResponse means this is free for that path).
  _ackResponse({ ok: true });

  // 4. Process
  try {
    const { chatId, text, fromId, fromUsername, fromFirstName, isCommand, command, isNonText, chatType, chatTitle, isForum, messageThreadId, forumEvent } = parsed;

    // Seen-chat recording (QTG-PRO P0 onboarding wizard): every real inbound
    // message upserts a chat-level telegram_chats row so the wizard can show
    // "chats seen" without a separate registration step. Fail-soft, must
    // never block the message flow below.
    try {
      _recordSeenChat({ botId: botId || 'default', chatId, chatType, isForum, title: chatTitle });
    } catch (err) {
      console.error('[Telegram] recordSeenChat failed:', err.message);
    }

    // Forum service messages (topic created/renamed/closed/reopened) are
    // registry sync only: they update threadRegistry and never reach the
    // chat pipeline.
    if (forumEvent) {
      try {
        _recordServiceMessage({ botId: botId || 'default', chatId, msg: update.message || update.edited_message });
      } catch (err) {
        console.error('[Telegram] recordServiceMessage failed:', err.message);
      }
      return { ok: true };
    }

    // AOCL-CUTOVER-3b: optional shadow observer (fire-and-forget, never blocks)
    try {
      const { getStackMode } = require('./aoclStackMode.js');
      const { maybeRunWebhookShadow } = require('./shadowRunner.js');
      const mode = getStackMode();
      if (mode !== 'legacy') {
        maybeRunWebhookShadow({
          mode,
          provider: 'telegram',
          botRecord: { bot_id: botId || 'default', org_id: config.org_id || null, agent_id: 'quox' },
          message: text || '',
          chatId,
        }).catch(() => {});
      }
    } catch { /* shadow must never break webhook */ }

    // Log inbound
    _storeAuditEnvelope({
      type: 'event',
      from: `telegram.${fromId || chatId}`,
      to: 'agent.quox',
      intent: 'quox.channel.telegram.inbound',
      corr: `TG_${chatId}_${Date.now()}`,
      payload: { chat_id: chatId, from_username: fromUsername, text: text.substring(0, 200), chat_type: chatType }
    });

    // Inbound digest interruption: a human message in a group/forum chat
    // must close any open digest for that lane so a reply never gets buried
    // under a message that keeps getting silently edited.
    if (chatType !== 'private') {
      try {
        _notifyInbound(chatId, messageThreadId ?? null);
      } catch (err) {
        console.error('[Telegram] notifyInbound failed:', err.message);
      }
    }

    // Binding-aware routing (QTG-PRO P0, minimal form): a session binding
    // hands the message straight to the terminal's inbox stream, no reply,
    // no chat pipeline. An owner binding or no binding at all falls through
    // to the existing mention-gated chat pipeline below.
    const binding = _getBindingForInbound({
      botId: botId || 'default',
      tgChatId: String(chatId),
      messageThreadId: messageThreadId ?? null
    });
    if (binding && binding.target_kind === 'session') {
      _appendSessionInbox(binding.target_id, {
        chatId,
        threadId: messageThreadId ?? null,
        from: fromUsername || fromFirstName || String(fromId || ''),
        text
      });
      return { ok: true };
    }

    // Group message filtering — only respond if bot mentioned
    if (chatType !== 'private') {
      if (!isBotMentioned(parsed, config.bot_username)) {
        return { ok: true };
      }
    }

    // Org ID for replies — resolved from config until user is known
    const defaultOrgId = config.default_org_id;

    // Non-text messages
    if (isNonText) {
      await _sendReply(...replyArgs(chatId, 'I can only process text messages for now.', defaultOrgId, messageThreadId));
      _storeAuditEnvelope({
        type: 'event',
        from: 'agent.quox',
        to: `telegram.${chatId}`,
        intent: 'quox.channel.telegram.outbound',
        corr: `TG_${chatId}_${Date.now()}`,
        payload: { chat_id: chatId, reply: 'non-text rejection' }
      });
      return { ok: true };
    }

    // Handle commands
    if (isCommand) {
      let reply;
      switch (command) {
        case '/start':
          reply = 'Welcome to CommanderQ! Send me a message and I\'ll route it to the right agent. Type /help to see available commands.';
          break;
        case '/help':
          reply = 'Available commands:\n/start — Welcome message\n/help — Show this help\n/status — Check connection status\n\nJust type a message to chat with CommanderQ.';
          break;
        case '/status':
          reply = `Connected. Chat ID: ${chatId}`;
          break;
        default:
          reply = `Unknown command: ${command}. Type /help to see available commands.`;
      }
      await _sendReply(...replyArgs(chatId, reply, defaultOrgId, messageThreadId));
      _storeAuditEnvelope({
        type: 'event',
        from: 'agent.quox',
        to: `telegram.${chatId}`,
        intent: 'quox.channel.telegram.outbound',
        corr: `TG_${chatId}_${Date.now()}`,
        payload: { chat_id: chatId, command, reply: reply.substring(0, 200) }
      });
      return { ok: true };
    }

    // 5. Resolve user
    const user = await _resolveUser(chatId);

    if (user) {
      // Known user — route through agent pipeline, use user's org for replies
      const userOrgId = user.org_id || defaultOrgId;
      conversationStore.addTurn(chatId, 'user', text);
      // LUCID: private (direct) chats only; group chatter is never ingested.
      const lucidDm = chatType === 'private';
      if (lucidDm) { try { require('./lucid/emit.js').messageEvent('telegram', userOrgId, { chat: chatId, msg: parsed.messageId, from: fromFirstName || fromUsername, phase: 'received' }); } catch { /* LUCID must never break chat */ } }

      try {
        // AOCL-DISPATCH-4: try authoritative webhook stack first (dormant by default).
        // When gated open, this produces webhook-specific L0-L10 envelopes via
        // runWebhookChat; otherwise falls through to legacy HTTP routing. There is
        // no Express req object here (shared by polling, which has none), so
        // tryWebhookStackDispatch falls back to its own req:{body:{},headers:{}}
        // default, same as it already does when req is omitted.
        let result = null;
        try {
          const { tryWebhookStackDispatch } = require('./webhookStackDispatch.js');
          const { getStackMode } = require('./aoclStackMode.js');
          const { getShadowMetrics } = require('./shadowRunner.js');
          const stackAttempt = await tryWebhookStackDispatch(
            {
              provider: 'telegram',
              botRecord: { bot_id: botId || 'default', org_id: user.org_id, agent_id: config.default_agent || 'quox' },
              message: text,
              chatId,
            },
            {
              getStackMode,
              getShadowMetrics,
              invokeDispatch: async ({ prompt }) => {
                const r = await _routeToChatPipeline(user.org_id, user.user_id, prompt, chatId, config.default_agent);
                return {
                  text: r?.result || r?.error || '',
                  tokensUsed: 0,
                  toolsUsed: Array.isArray(r?.tools_used) ? r.tools_used : [],
                  model: r?.model || 'claude-sonnet-4-6',
                  path: 'webhook_delegate',
                };
              },
            },
          );
          if (stackAttempt.stackUsed && stackAttempt.proceed) {
            result = { success: true, result: stackAttempt.response, _stack_used: true };
          } else if (stackAttempt.stackUsed && !stackAttempt.proceed
                     && stackAttempt.deniedAtLayer
                     && ['L1', 'L2', 'L3'].includes(stackAttempt.deniedAtLayer)) {
            // Policy denial at an identity/router/policy layer — surface it.
            result = { success: false, result: stackAttempt.response || 'This request was blocked by policy.', _stack_used: true };
          }
          // Any other stack outcome (L7 dispatcher failure, stack exception,
          // gate closed) falls through to legacy _routeToChatPipeline below.
        } catch (stackErr) {
          console.error('[Telegram] Stack dispatch failed, falling back to legacy:', stackErr?.message || stackErr);
        }
        if (!result) {
          result = await _routeToChatPipeline(user.org_id, user.user_id, text, chatId, config.default_agent);
        }
        const reply = result.result || result.error || 'No response from agent.';
        conversationStore.addTurn(chatId, 'assistant', reply);
        await _sendReply(...replyArgs(chatId, reply, userOrgId, messageThreadId));
        if (lucidDm) { try { require('./lucid/emit.js').messageEvent('telegram', userOrgId, { chat: chatId, msg: parsed.messageId, from: fromFirstName || fromUsername, phase: 'answered' }); } catch { /* LUCID must never break chat */ } }

        _storeAuditEnvelope({
          type: 'result',
          from: 'agent.quox',
          to: `telegram.${chatId}`,
          intent: 'quox.channel.telegram.outbound',
          corr: `TG_${chatId}_${Date.now()}`,
          payload: { chat_id: chatId, user_id: user.user_id, reply_length: reply.length, success: !!result.success }
        });
      } catch (err) {
        console.error('[Telegram] Chat pipeline error:', err.message);
        await _sendReply(...replyArgs(chatId, 'Sorry, I encountered an error processing your message. Please try again.', userOrgId, messageThreadId));
      }
    } else {
      // Unknown user — create inbox item + send ack
      await _createInboxItem(chatId, fromUsername, fromFirstName, text, defaultOrgId);
      await _sendReply(...replyArgs(chatId, 'Thanks for your message. I\'ve forwarded it to the team. To link your Telegram account, please set up Telegram notifications in your Quox dashboard.', defaultOrgId, messageThreadId));

      _storeAuditEnvelope({
        type: 'event',
        from: 'agent.quox',
        to: `telegram.${chatId}`,
        intent: 'quox.channel.telegram.outbound.unknown_user',
        corr: `TG_${chatId}_${Date.now()}`,
        payload: { chat_id: chatId, from_username: fromUsername, action: 'inbox_created' }
      });
    }
  } catch (err) {
    console.error('[Telegram] Update processing error:', err);
  }

  return { ok: true };
}

// ============================================================================
// Main Webhook Handler
// ============================================================================

/**
 * Main webhook handler.
 * Validates the secret token, then delegates the actual per-update work to
 * processTelegramUpdate, which sends the immediate 200 ack via the injected
 * ackResponse callback before continuing with (potentially slow) message
 * processing — same fast-response-first behaviour this handler always had.
 *
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {object} [deps] - Injectable dependencies for testing
 */
async function handleTelegramWebhook(req, res, deps = {}) {
  const _getConfig = deps.getWebhookConfig || getWebhookConfig;
  const botId = deps.botId || undefined;

  // 1. Resolve config from vault/instance_config (cached 30s, per-bot)
  const config = await _getConfig(botId);

  // 2. Validate secret token — MANDATORY (fail-closed). A bot with no
  // webhook_secret configured is rejected outright rather than accepted
  // unconditionally (COLLECTOR-AUTH §6.2 — was fail-open).
  if (!config.webhook_secret) {
    console.warn(`[collector-webhook] reject method=POST path=${req.path} reason=missing-secret`);
    return res.status(401).json({ error: 'Webhook secret not configured' });
  }
  {
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (!headerSecret || headerSecret !== config.webhook_secret) {
      console.warn(`[collector-webhook] reject method=POST path=${req.path} reason=bad-sig`);
      return res.status(403).json({ error: 'Invalid secret token' });
    }
  }

  // 3. Process the update. ackResponse fires res.json as soon as
  // processTelegramUpdate knows what to say (deduped / ignored / accepted),
  // before any of the potentially slow user-resolution/chat-pipeline work.
  await processTelegramUpdate(req.body, {
    botId,
    config,
    deps: {
      ...deps,
      ackResponse: (body) => res.json(body),
    },
  });
}

module.exports = {
  handleTelegramWebhook,
  processTelegramUpdate,
  parseUpdate,
  conversationStore,
  getWebhookConfig,
  clearConfigCache,
  _internals: {
    resolveUser,
    routeToChatPipeline,
    createInboxItem,
    sendReply,
    isBotMentioned,
    appendSessionInbox,
    replyArgs
  }
};
