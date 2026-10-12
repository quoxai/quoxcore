/**
 * Discord Inbound Webhook Handler
 *
 * Receives Discord Interactions (slash commands, message components) via HTTP POST.
 * Uses Ed25519 signature validation per Discord requirements.
 *
 * Also supports a message-relay endpoint for Discord bots that forward
 * channel messages to Quox (via a simple bot that POSTs to /webhook/discord).
 *
 * Flow:
 *  1. Validate Ed25519 signature (required by Discord)
 *  2. Handle PING (type 1) — respond with PONG
 *  3. Handle APPLICATION_COMMAND (type 2) — slash commands like /ask
 *  4. Resolve Discord user to Quox user via auth service
 *  5. Route to /chat/claude pipeline or create inbox item
 *
 * Config (bot token, public key, application ID) resolved from QuoxVault
 * via the auth service — no env vars needed.
 *
 * AEE audit envelopes logged for all inbound/outbound messages.
 */

const { validateInteractionSignature, deferInteractionResponse, editOriginalInteractionResponse, sendChannelMessage } = require('../utils/discordSetup');
const configResolver = require('./configResolver.js');

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;
const COLLECTOR_PORT = process.env.COLLECTOR_PORT || 9848;
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const MAX_REPLY_LENGTH = 2000; // Discord message limit

// ============================================================================
// Webhook Config — resolved from auth service, cached with TTL
// ============================================================================

let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL = 30_000;

/**
 * Fetch Discord webhook config from auth service.
 * Cached for 30s. Returns:
 *   { bot_token, public_key, application_id, default_org_id, default_agent, webhook_active }
 */
async function getDiscordWebhookConfig() {
  const now = Date.now();
  if (_configCache && (now - _configCacheTime) < CONFIG_CACHE_TTL) {
    return _configCache;
  }

  try {
    const resp = await fetch(`${AUTH_BASE_URL}/api/internal/discord-webhook-config`, {
      headers: INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (resp.ok) {
      _configCache = await resp.json();
      _configCacheTime = now;
      return _configCache;
    }
    console.warn(`[Discord] Config fetch returned ${resp.status} — falling back to env vars`);
  } catch (err) {
    console.warn('[Discord] Config fetch failed:', err.message, '— falling back to env vars');
  }

  if (_configCache) return _configCache;

  // VAULT-INTEG P3: last-resort fallback only — the vault-first path above
  // (auth's /api/internal/discord-webhook-config, itself vault-first over
  // integration_credentials, see services/auth/routes/inbox.js) is unreachable
  // here. A one-line warn when this branch actually supplies a secret, so a
  // deploy relying on it shows up in logs rather than silently working.
  if (process.env.DISCORD_BOT_TOKEN) {
    console.warn('[Discord] Using DISCORD_BOT_TOKEN env fallback (vault config unavailable)');
  }

  // VAULT-INTEG P17: application_id was a bare process.env read — now
  // resolved via configResolver.getInstanceSetting() (platformCapabilities.js
  // DISCORD_APPLICATION_ID). No org is known yet at this point (this
  // branch only runs when the vault-first lookup above is unreachable), so
  // this is instance-scoped, not org-scoped.
  return {
    bot_token: process.env.DISCORD_BOT_TOKEN || '',
    public_key: process.env.DISCORD_PUBLIC_KEY || '',
    application_id: configResolver.getInstanceSetting('DISCORD_APPLICATION_ID').value || '',
    default_org_id: process.env.DEFAULT_ORG_ID || '',
    default_agent: 'quox',
    webhook_active: false,
    has_token: !!process.env.DISCORD_BOT_TOKEN
  };
}

function clearDiscordConfigCache() {
  _configCache = null;
  _configCacheTime = 0;
}

// ============================================================================
// Interaction Parsing
// ============================================================================

// Discord Interaction Types
const INTERACTION_TYPES = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  MODAL_SUBMIT: 5
};

/**
 * Parse a Discord interaction into a normalized message.
 * @param {object} body - Discord interaction payload
 * @returns {object|null} parsed message or null if not actionable
 */
function parseInteraction(body) {
  if (!body || !body.type) return null;

  // Slash commands (type 2)
  if (body.type === INTERACTION_TYPES.APPLICATION_COMMAND) {
    const data = body.data || {};
    const user = body.member?.user || body.user;
    const options = data.options || [];

    // Extract the text from the first string option (e.g., /ask <query>)
    const textOption = options.find(o => o.type === 3); // STRING type
    const text = textOption?.value || '';

    return {
      interactionId: body.id,
      interactionToken: body.token,
      applicationId: body.application_id,
      commandName: data.name,
      text,
      userId: user?.id,
      username: user?.username,
      globalName: user?.global_name || user?.username,
      channelId: body.channel_id,
      guildId: body.guild_id,
      isDM: !body.guild_id,
      type: 'slash_command'
    };
  }

  // Message relay (custom — bot forwards channel messages as POST body)
  if (body.type === 'message_relay') {
    return {
      text: body.content || '',
      userId: body.author_id,
      username: body.author_username,
      globalName: body.author_global_name || body.author_username,
      channelId: body.channel_id,
      guildId: body.guild_id,
      isDM: !body.guild_id,
      type: 'message_relay'
    };
  }

  return null;
}

// ============================================================================
// User Resolution & Routing
// ============================================================================

/**
 * Resolve Discord user_id to Quox user via auth service.
 */
async function resolveDiscordUser(discordUserId) {
  try {
    const resp = await fetch(
      `${AUTH_BASE_URL}/api/internal/discord-user-lookup?user_id=${encodeURIComponent(discordUserId)}`,
      {
        headers: INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {},
        signal: AbortSignal.timeout(5000)
      }
    );
    if (resp.ok) {
      const data = await resp.json();
      return data.user || null;
    }
  } catch (err) {
    console.error('[Discord] User lookup failed:', err.message);
  }
  return null;
}

/**
 * Route message through /chat/claude pipeline.
 */
async function routeToChatPipeline(orgId, userId, prompt, channelId, defaultAgent) {
  const body = {
    prompt,
    selected_agent: defaultAgent || 'quox',
    session_id: `discord_${channelId}`,
    conversation_history: [],
    org_id: orgId,
    user_id: userId
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
 * Create inbox item for unknown Discord user.
 */
async function createInboxItem(discordUserId, username, text, orgId) {
  if (!orgId) return;

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
        title: `Discord message from ${username || discordUserId}`,
        body_md: `**From:** Discord user \`${username || discordUserId}\`\n\n${text.substring(0, 1000)}`,
        payload: { source: 'discord', discord_user_id: discordUserId, username }
      }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    console.error('[Discord] Failed to create inbox item:', err.message);
  }
}

// ============================================================================
// Main Webhook Handler
// ============================================================================

/**
 * Main Discord Interactions webhook handler.
 *
 * @param {object} req - Express request (must have rawBody attached)
 * @param {object} res - Express response
 * @param {object} [deps] - Injectable dependencies for testing
 */
async function handleDiscordWebhook(req, res, deps = {}) {
  const _storeAuditEnvelope = deps.storeAuditEnvelope || (() => {});
  const _resolveUser = deps.resolveDiscordUser || resolveDiscordUser;
  const _routeToChatPipeline = deps.routeToChatPipeline || routeToChatPipeline;
  const _createInboxItem = deps.createInboxItem || createInboxItem;
  const _getConfig = deps.getDiscordWebhookConfig || getDiscordWebhookConfig;
  const _sendReply = deps.sendChannelMessage || sendChannelMessage;
  const _deferResponse = deps.deferInteractionResponse || deferInteractionResponse;
  const _editResponse = deps.editOriginalInteractionResponse || editOriginalInteractionResponse;

  const body = req.body;

  // 1. Resolve config
  const config = await _getConfig();

  // 2. Validate Ed25519 signature (required by Discord for Interactions endpoint)
  if (config.public_key && req.rawBody) {
    const timestamp = req.headers['x-signature-timestamp'];
    const signature = req.headers['x-signature-ed25519'];
    if (!timestamp || !signature || !validateInteractionSignature(config.public_key, timestamp, req.rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid request signature' });
    }
  }

  // 3. Handle PING (Discord verification handshake)
  if (body.type === INTERACTION_TYPES.PING) {
    return res.json({ type: 1 }); // PONG
  }

  // 4. Parse interaction
  const parsed = parseInteraction(body);
  if (!parsed) {
    return res.json({ type: 1 }); // Acknowledge unknown types
  }

  // 5. For slash commands — defer response (shows "thinking...")
  if (parsed.type === 'slash_command') {
    // Must respond within 3 seconds — defer immediately
    await _deferResponse(parsed.interactionId, parsed.interactionToken);
    res.status(204).end();
  } else {
    // Message relay — respond 200 immediately
    res.json({ ok: true });
  }

  // 6. Process async
  try {
    const { text, userId, username, globalName, channelId, commandName } = parsed;

    // AOCL-CUTOVER-3b: optional shadow observer (fire-and-forget, never blocks)
    try {
      const { getStackMode } = require('./aoclStackMode.js');
      const { maybeRunWebhookShadow } = require('./shadowRunner.js');
      const mode = getStackMode();
      if (mode !== 'legacy') {
        maybeRunWebhookShadow({
          mode,
          provider: 'discord',
          botRecord: { bot_id: config.bot_id || 'default', org_id: config.org_id || null, agent_id: 'quox' },
          message: text || '',
          chatId: channelId,
        }).catch(() => {});
      }
    } catch { /* shadow must never break webhook */ }

    _storeAuditEnvelope({
      type: 'event',
      from: `discord.${userId}`,
      to: 'agent.quox',
      intent: 'quox.channel.discord.inbound',
      corr: `DC_${channelId}_${Date.now()}`,
      payload: { channel_id: channelId, user_id: userId, username, text: text.substring(0, 200), command: commandName }
    });

    if (!text) {
      // No text content
      if (parsed.type === 'slash_command') {
        await _editResponse(parsed.applicationId, parsed.interactionToken, 'Please provide a message. Usage: `/ask <your question>`');
      }
      return;
    }

    const defaultOrgId = config.default_org_id;
    const user = await _resolveUser(userId);

    if (user) {
      const userOrgId = user.org_id || defaultOrgId;

      try {
        // AOCL-DISPATCH-4: try authoritative webhook stack first (dormant by default).
        let result = null;
        try {
          const { tryWebhookStackDispatch } = require('./webhookStackDispatch.js');
          const { getStackMode } = require('./aoclStackMode.js');
          const { getShadowMetrics } = require('./shadowRunner.js');
          const stackAttempt = await tryWebhookStackDispatch(
            {
              req,
              provider: 'discord',
              botRecord: { bot_id: 'default', org_id: user.org_id, agent_id: config.default_agent || 'quox' },
              message: text,
              chatId: channelId,
            },
            {
              getStackMode,
              getShadowMetrics,
              invokeDispatch: async ({ prompt }) => {
                const r = await _routeToChatPipeline(user.org_id, user.user_id, prompt, channelId, config.default_agent);
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
            result = { success: false, result: stackAttempt.response || 'This request was blocked by policy.', _stack_used: true };
          }
        } catch (stackErr) {
          console.error('[Discord] Stack dispatch failed, falling back to legacy:', stackErr?.message || stackErr);
        }
        if (!result) {
          result = await _routeToChatPipeline(user.org_id, user.user_id, text, channelId, config.default_agent);
        }
        const reply = result.result || result.error || 'No response from agent.';
        const truncated = reply.length > MAX_REPLY_LENGTH ? reply.substring(0, MAX_REPLY_LENGTH - 3) + '...' : reply;

        if (parsed.type === 'slash_command') {
          await _editResponse(parsed.applicationId, parsed.interactionToken, truncated);
        } else {
          await _sendReply(config.bot_token, channelId, truncated);
        }

        _storeAuditEnvelope({
          type: 'result',
          from: 'agent.quox',
          to: `discord.${userId}`,
          intent: 'quox.channel.discord.outbound',
          corr: `DC_${channelId}_${Date.now()}`,
          payload: { channel_id: channelId, user_id: userId, reply_length: reply.length, success: !!result.success }
        });
      } catch (err) {
        console.error('[Discord] Chat pipeline error:', err.message);
        const errMsg = 'Sorry, I encountered an error processing your message. Please try again.';
        if (parsed.type === 'slash_command') {
          await _editResponse(parsed.applicationId, parsed.interactionToken, errMsg);
        } else {
          await _sendReply(config.bot_token, channelId, errMsg);
        }
      }
    } else {
      await _createInboxItem(userId, username || globalName, text, defaultOrgId);
      const ackMsg = 'Thanks for your message. I\'ve forwarded it to the team. To link your Discord account, set up Discord notifications in your Quox dashboard.';
      if (parsed.type === 'slash_command') {
        await _editResponse(parsed.applicationId, parsed.interactionToken, ackMsg);
      } else {
        await _sendReply(config.bot_token, channelId, ackMsg);
      }

      _storeAuditEnvelope({
        type: 'event',
        from: 'agent.quox',
        to: `discord.${userId}`,
        intent: 'quox.channel.discord.outbound.unknown_user',
        corr: `DC_${channelId}_${Date.now()}`,
        payload: { channel_id: channelId, discord_user_id: userId, action: 'inbox_created' }
      });
    }
  } catch (err) {
    console.error('[Discord] Webhook processing error:', err);
  }
}

module.exports = {
  handleDiscordWebhook,
  parseInteraction,
  getDiscordWebhookConfig,
  clearDiscordConfigCache,
  INTERACTION_TYPES,
  _internals: {
    resolveDiscordUser,
    routeToChatPipeline,
    createInboxItem
  }
};
