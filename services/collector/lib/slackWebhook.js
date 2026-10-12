/**
 * Slack Inbound Webhook Handler
 *
 * Receives Slack Events API payloads, resolves the sender to a Quox user,
 * routes messages through the /chat/claude pipeline, and sends replies
 * back via Slack chat.postMessage.
 *
 * Supports: url_verification challenge, message events, app_mention events.
 * Unknown senders get an inbox item for org admins.
 *
 * Config (bot token, signing secret, org) is resolved from QuoxVault
 * via the auth service — no env vars needed.
 *
 * AEE audit envelopes logged for all inbound/outbound messages.
 */

const { validateSignature, postMessage } = require('../utils/slackSetup');

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;
const COLLECTOR_PORT = process.env.COLLECTOR_PORT || 9848;
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const MAX_REPLY_LENGTH = 3000; // Slack soft limit for readability

// ============================================================================
// Webhook Config — resolved from auth service, cached with TTL
// ============================================================================

let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL = 30_000;

/**
 * Fetch webhook config from auth service (vault + instance_config).
 * Cached for 30s. Returns:
 *   { bot_token, signing_secret, bot_username, default_org_id, default_agent, webhook_active }
 */
async function getSlackWebhookConfig() {
  const now = Date.now();
  if (_configCache && (now - _configCacheTime) < CONFIG_CACHE_TTL) {
    return _configCache;
  }

  try {
    const resp = await fetch(`${AUTH_BASE_URL}/api/internal/slack-webhook-config`, {
      headers: INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (resp.ok) {
      _configCache = await resp.json();
      _configCacheTime = now;
      return _configCache;
    }
  } catch (err) {
    console.warn('[Slack] Config fetch failed:', err.message);
  }

  if (_configCache) return _configCache;

  return {
    bot_token: process.env.SLACK_BOT_TOKEN || '',
    signing_secret: process.env.SLACK_SIGNING_SECRET || '',
    bot_username: '',
    default_org_id: process.env.DEFAULT_ORG_ID || '',
    default_agent: 'quox',
    webhook_active: false,
    has_token: !!process.env.SLACK_BOT_TOKEN
  };
}

function clearSlackConfigCache() {
  _configCache = null;
  _configCacheTime = 0;
}

// ============================================================================
// Event Parsing
// ============================================================================

/**
 * Parse a Slack Events API payload into a normalized message.
 * @param {object} body - Slack event payload
 * @returns {object|null} parsed message or null if not actionable
 */
function parseSlackEvent(body) {
  const event = body.event;
  if (!event) return null;

  // Only handle message and app_mention events
  if (event.type !== 'message' && event.type !== 'app_mention') return null;

  // Ignore bot messages, message_changed, etc.
  if (event.subtype) return null;
  if (event.bot_id) return null;

  return {
    channelId: event.channel,
    text: event.text || '',
    userId: event.user,
    threadTs: event.thread_ts || event.ts,
    eventTs: event.ts,
    eventType: event.type,
    teamId: body.team_id,
    isDirectMessage: event.channel_type === 'im',
    isAppMention: event.type === 'app_mention'
  };
}

// ============================================================================
// User Resolution & Routing
// ============================================================================

/**
 * Resolve Slack user_id to Quox user via auth service.
 */
async function resolveSlackUser(slackUserId) {
  try {
    const resp = await fetch(
      `${AUTH_BASE_URL}/api/internal/slack-user-lookup?user_id=${encodeURIComponent(slackUserId)}`,
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
    console.error('[Slack] User lookup failed:', err.message);
  }
  return null;
}

/**
 * Route message through /chat/claude pipeline with service-key auth.
 */
async function routeToChatPipeline(orgId, userId, prompt, channelId, defaultAgent) {
  const body = {
    prompt,
    selected_agent: defaultAgent || 'quox',
    session_id: `slack_${channelId}`,
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
 * Create inbox item for unknown Slack user.
 */
async function createInboxItem(slackUserId, text, orgId) {
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
        title: `Slack message from ${slackUserId}`,
        body_md: `**From:** Slack user \`${slackUserId}\`\n\n${text.substring(0, 1000)}`,
        payload: { source: 'slack', slack_user_id: slackUserId }
      }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    console.error('[Slack] Failed to create inbox item:', err.message);
  }
}

// ============================================================================
// Main Webhook Handler
// ============================================================================

/**
 * Main Slack Events API webhook handler.
 *
 * Handles:
 *  - url_verification challenge (Slack app setup)
 *  - event_callback with message/app_mention events
 *
 * @param {object} req - Express request (must have rawBody attached)
 * @param {object} res - Express response
 * @param {object} [deps] - Injectable dependencies for testing
 */
async function handleSlackWebhook(req, res, deps = {}) {
  const _storeAuditEnvelope = deps.storeAuditEnvelope || (() => {});
  const _resolveUser = deps.resolveSlackUser || resolveSlackUser;
  const _routeToChatPipeline = deps.routeToChatPipeline || routeToChatPipeline;
  const _createInboxItem = deps.createInboxItem || createInboxItem;
  const _postMessage = deps.postMessage || postMessage;
  const _getConfig = deps.getSlackWebhookConfig || getSlackWebhookConfig;

  const body = req.body;

  // 1. Handle url_verification challenge (Slack setup handshake)
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  // 2. Resolve config
  const config = await _getConfig();

  // 3. Validate request signature
  if (config.signing_secret && req.rawBody) {
    const timestamp = req.headers['x-slack-request-timestamp'];
    const signature = req.headers['x-slack-signature'];
    if (!timestamp || !signature || !validateSignature(config.signing_secret, timestamp, req.rawBody, signature)) {
      return res.status(403).json({ error: 'Invalid signature' });
    }
  }

  // 4. Must be an event_callback
  if (body.type !== 'event_callback') {
    return res.json({ ok: true });
  }

  // 5. Parse event
  const parsed = parseSlackEvent(body);
  if (!parsed) {
    return res.json({ ok: true });
  }

  // 6. Respond 200 immediately (Slack requires response within 3s)
  res.json({ ok: true });

  // 7. Process async
  try {
    const { channelId, text, userId, threadTs, isDirectMessage, isAppMention } = parsed;

    // AOCL-CUTOVER-3b: optional shadow observer (fire-and-forget, never blocks)
    try {
      const { getStackMode } = require('./aoclStackMode.js');
      const { maybeRunWebhookShadow } = require('./shadowRunner.js');
      const mode = getStackMode();
      if (mode !== 'legacy') {
        maybeRunWebhookShadow({
          mode,
          provider: 'slack',
          botRecord: { bot_id: config.bot_id || 'default', org_id: config.org_id || null, agent_id: 'quox' },
          message: text || '',
          chatId: channelId,
        }).catch(() => {});
      }
    } catch { /* shadow must never break webhook */ }

    _storeAuditEnvelope({
      type: 'event',
      from: `slack.${userId}`,
      to: 'agent.quox',
      intent: 'quox.channel.slack.inbound',
      corr: `SL_${channelId}_${Date.now()}`,
      payload: { channel_id: channelId, user_id: userId, text: text.substring(0, 200), is_dm: isDirectMessage }
    });

    // Strip bot mention from text if app_mention
    let cleanText = text;
    if (isAppMention) {
      cleanText = text.replace(/<@[A-Z0-9]+>/g, '').trim();
    }

    if (!cleanText) return;

    const defaultOrgId = config.default_org_id;
    const user = await _resolveUser(userId);

    if (user) {
      // LUCID: direct messages only; channel chatter and mentions are never ingested.
      const lucidDm = isDirectMessage;
      if (lucidDm) { try { require('./lucid/emit.js').messageEvent('slack', user.org_id, { chat: channelId, msg: parsed.eventTs, from: user.name || user.display_name || userId, phase: 'received' }); } catch { /* LUCID must never break chat */ } }
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
              provider: 'slack',
              botRecord: { bot_id: 'default', org_id: user.org_id, agent_id: config.default_agent || 'quox' },
              message: cleanText,
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
          console.error('[Slack] Stack dispatch failed, falling back to legacy:', stackErr?.message || stackErr);
        }
        if (!result) {
          result = await _routeToChatPipeline(user.org_id, user.user_id, cleanText, channelId, config.default_agent);
        }
        const reply = result.result || result.error || 'No response from agent.';
        const truncated = reply.length > MAX_REPLY_LENGTH ? reply.substring(0, MAX_REPLY_LENGTH - 3) + '...' : reply;

        await _postMessage(config.bot_token, channelId, truncated);
        if (lucidDm) { try { require('./lucid/emit.js').messageEvent('slack', user.org_id, { chat: channelId, msg: parsed.eventTs, from: user.name || user.display_name || userId, phase: 'answered' }); } catch { /* LUCID must never break chat */ } }

        _storeAuditEnvelope({
          type: 'result',
          from: 'agent.quox',
          to: `slack.${userId}`,
          intent: 'quox.channel.slack.outbound',
          corr: `SL_${channelId}_${Date.now()}`,
          payload: { channel_id: channelId, user_id: userId, reply_length: reply.length, success: !!result.success }
        });
      } catch (err) {
        console.error('[Slack] Chat pipeline error:', err.message);
        await _postMessage(config.bot_token, channelId, 'Sorry, I encountered an error processing your message. Please try again.');
      }
    } else {
      await _createInboxItem(userId, cleanText, defaultOrgId);
      await _postMessage(config.bot_token, channelId, 'Thanks for your message. I\'ve forwarded it to the team. To link your Slack account, set up Slack notifications in your Quox dashboard.');

      _storeAuditEnvelope({
        type: 'event',
        from: 'agent.quox',
        to: `slack.${userId}`,
        intent: 'quox.channel.slack.outbound.unknown_user',
        corr: `SL_${channelId}_${Date.now()}`,
        payload: { channel_id: channelId, slack_user_id: userId, action: 'inbox_created' }
      });
    }
  } catch (err) {
    console.error('[Slack] Webhook processing error:', err);
  }
}

module.exports = {
  handleSlackWebhook,
  parseSlackEvent,
  getSlackWebhookConfig,
  clearSlackConfigCache,
  _internals: {
    resolveSlackUser,
    routeToChatPipeline,
    createInboxItem
  }
};
