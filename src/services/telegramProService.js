/**
 * telegramProService: API client for the Quox Telegram Pro plugin's
 * multi-bot roster + onboarding wizard (QTG-PRO P0 → roster evolution).
 *
 * Wraps three things:
 *   1. Vault credential write for each bot's token, via the shared
 *      integrationsClient (POST /api/orgs/:orgId/integrations). The token
 *      NEVER touches localStorage or orgScopedStorage: vault only. This is
 *      the ZERO TOLERANCE replacement for ChannelConfigPanel's old
 *      localStorage-backed telegram config.
 *      integrationTypeRegistry.js:648 defines exactly one integration_type
 *      ('telegram') with a single credential field (`bot_token`): there is
 *      no per-kind sub-type. Multi-bot differentiation (kind, agent_id) is
 *      carried in the `metadata` field integrations.js:289 already accepts
 *      and stores as metadata_json; uniqueness across bots is enforced by
 *      (org, type, label): see integrations.js labelExists(): so every
 *      bot gets a distinct label.
 *   2. The existing collector webhook admin endpoints (same-origin
 *      /collector/webhook/telegram/* proxy, credentials: 'include'),
 *      mirrored from coreCommsService.js's registerTelegramWebhook() /
 *      getTelegramWebhookInfo(), now parameterized by botId:
 *        - POST /webhook/telegram/setup ALREADY accepts { bot_id } today
 *          (services/collector/server.js:18397-18428 destructures bot_id
 *          from the body and resolves the vault token via
 *          getWebhookConfig(bot_id)): real multi-bot support, not a guess.
 *        - GET /webhook/telegram/info does NOT accept bot_id today
 *          (server.js:18509 calls getWebhookConfig() with no argument):
 *          this is a real contract gap. getWebhookInfo(botId) below still
 *          sends bot_id as a query param so the backend can start honoring
 *          it without another UI change; until then it is silently ignored
 *          server-side and the call effectively returns the default bot's
 *          info. The wizard does not currently depend on this for identity
 *          display: it uses the bot_username already returned inline by
 *          the /setup response.
 *   3. The telegram-pro onboarding endpoints. These are owned by a parallel
 *      stream and may 404 until that backend ships: every call here treats
 *      a 404 as "backend not deployed yet" and returns notDeployed: true
 *      instead of throwing, so the UI can show a soft warning banner, never
 *      crash.
 *      GET /telegram-pro/onboarding/status is being extended in parallel to
 *      return a `bots: []` roster array. Until it does, getBots() below
 *      synthesizes a one-entry roster from the legacy { bot, webhook,
 *      chats_seen, owner_binding } shape.
 *      POST /telegram-pro/onboarding/bind-owner only documented { tg_chat_id }
 *      in the original P0 contract. bindChat(tgChatId, botId) below also
 *      sends bot_id so a bot other than the gateway can be associated with
 *      a chat: this is a REQUEST to the backend, not a confirmed contract;
 *      until the backend reads bot_id, every bind resolves against the
 *      single owner binding regardless of which bot initiated it.
 */

import { createIntegration } from './integrationsClient'

async function safeJson(resp) {
  try {
    return await resp.json()
  } catch {
    return {}
  }
}

function defaultLabel(kind, agentId) {
  if (kind === 'agent') return `Quox Agent Bot (${agentId || 'unassigned'})`
  if (kind === 'notify') return 'Quox Notify Bot'
  return 'Quox Gateway Bot'
}

/**
 * Step 2a: save a bot's token to the vault.
 * @param {string} token - Bot token from BotFather
 * @param {Object} [opts]
 * @param {string} [opts.label] - Unique label for this bot's vault credential
 * @param {'gateway'|'agent'|'notify'} [opts.kind]
 * @param {string} [opts.agentId] - Required for kind 'agent'
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
export async function saveBotToken(token, { label, kind = 'gateway', agentId } = {}) {
  return createIntegration({
    integration_type: 'telegram',
    label: label || defaultLabel(kind, agentId),
    credentials: { bot_token: token },
    metadata: { kind, agent_id: kind === 'agent' ? (agentId || null) : null },
  })
}

/**
 * Step 2b: register the collector webhook for inbound updates, for a
 * specific bot. The collector resolves the token from the vault by botId
 * (the vault credential id returned from saveBotToken).
 * @param {string} webhookUrl - Public HTTPS URL Telegram should call
 * @param {string} [botId] - Vault credential id for the bot being set up
 * @returns {Promise<object>} result, or { notDeployed: true } on 404
 */
export async function setupWebhook(webhookUrl, botId) {
  try {
    const resp = await fetch('/collector/webhook/telegram/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ webhook_url: webhookUrl, bot_id: botId || undefined }),
    })
    if (resp.status === 404) return { notDeployed: true, success: false }
    return await safeJson(resp)
  } catch (err) {
    return { success: false, error: err.message }
  }
}

/**
 * Bot identity + webhook health (GET /webhook/telegram/info).
 * NOTE: the collector endpoint does not accept bot_id yet (see file
 * header): this always reports the default/most-recently-configured bot
 * until that ships. Kept parameterized so callers don't need to change later.
 * @param {string} [botId]
 * @returns {Promise<object>}
 */
export async function getWebhookInfo(botId) {
  try {
    const url = botId ? `/collector/webhook/telegram/info?bot_id=${encodeURIComponent(botId)}` : '/collector/webhook/telegram/info'
    const resp = await fetch(url, { credentials: 'include' })
    if (resp.status === 404) return { notDeployed: true, active: false, has_token: false }
    if (!resp.ok) return { active: false, has_token: false }
    return await resp.json()
  } catch {
    return { active: false, has_token: false, error: 'Failed to reach collector' }
  }
}

/**
 * Raw onboarding status: bot identity, webhook health, chats seen
 * (Topics-enabled candidate groups), and the current owner binding, if any.
 * Backend contract (QTG-PRO P0, parallel stream, legacy single-bot shape):
 *   GET /telegram-pro/onboarding/status ->
 *     { bot, webhook, chats_seen: [], owner_binding }
 * being extended to also return: { bots: [{ bot_id, username, name, kind,
 *   webhook_active, chats_bound, added_at }] }
 * @returns {Promise<object>}
 */
export async function getOnboardingStatus() {
  try {
    const resp = await fetch('/collector/telegram-pro/onboarding/status', { credentials: 'include' })
    if (resp.status === 404) {
      return { notDeployed: true, bot: null, webhook: null, chats_seen: [], owner_binding: null, bots: [] }
    }
    if (!resp.ok) {
      return { bot: null, webhook: null, chats_seen: [], owner_binding: null, bots: [], error: `HTTP ${resp.status}` }
    }
    return await resp.json()
  } catch (err) {
    return { bot: null, webhook: null, chats_seen: [], owner_binding: null, bots: [], error: err.message }
  }
}

/**
 * Roster shape for the Bots list. Prefers the real `bots[]` array once the
 * backend ships it; falls back to synthesizing a single gateway-bot row
 * from the legacy shape so the roster UI never breaks on old backends.
 * @returns {Promise<{bots: Array, raw: object}>}
 */
export async function getBots() {
  const status = await getOnboardingStatus()
  if (status.notDeployed) return { notDeployed: true, bots: [], raw: status }

  if (Array.isArray(status.bots) && status.bots.length > 0) {
    // Defensive mirror of the backend rule: an entry with no identity, no
    // webhook, and no chats is "nothing configured yet", not a bot. Older
    // backends synthesized such a placeholder for the default bot id, which
    // suppressed the onboarding empty state with a phantom roster row.
    const configured = status.bots.filter(
      (b) => b.username || b.webhook_active || (b.chats_bound || 0) > 0
    )
    return { bots: configured, raw: status }
  }

  if (status.bot) {
    return {
      bots: [{
        bot_id: 'legacy-default',
        username: status.bot.username,
        name: status.bot.name || status.bot.username,
        kind: 'gateway',
        webhook_active: !!status.webhook?.active,
        chats_bound: status.owner_binding ? 1 : 0,
        added_at: null,
        _legacyShape: true,
      }],
      raw: status,
    }
  }

  return { bots: [], raw: status }
}

/**
 * Step 4 (gateway) / "join" step (agent, notify): bind a chat to a bot.
 * Backend contract: POST /telegram-pro/onboarding/bind-owner { tg_chat_id }
 * -> { ok, binding }. bot_id is sent as a forward-looking extension (see
 * file header) so a non-gateway bot's binding can be told apart once the
 * backend reads it.
 * @param {string|number} tgChatId
 * @param {string} [botId]
 * @returns {Promise<object>}
 */
export async function bindChat(tgChatId, botId) {
  try {
    const resp = await fetch('/collector/telegram-pro/onboarding/bind-owner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ tg_chat_id: tgChatId, bot_id: botId || undefined }),
    })
    if (resp.status === 404) return { notDeployed: true, ok: false }
    return await safeJson(resp)
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// Back-compat alias: the original P0 gateway-only wizard called this
// bindOwnerChat(tgChatId). Same endpoint, botId now optional.
export const bindOwnerChat = bindChat

/**
 * Default connection path (owner decision 2026-07-26): most Quox Telegram
 * Pro installs are self-hosted with no public domain or IP, so the wizard
 * starts a long-polling worker (outbound-only getUpdates) instead of
 * registering a webhook. Webhook stays available as an opt-in "Advanced"
 * path for installs with a public HTTPS URL.
 *   POST /telegram-pro/polling/start { bot_id } -> { ok, polling: true }
 * @param {string} botId - Vault credential id for the bot being started
 * @returns {Promise<object>} result, or { notDeployed: true } on 404
 */
export async function startPolling(botId) {
  try {
    const resp = await fetch('/collector/telegram-pro/polling/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ bot_id: botId || undefined }),
    })
    if (resp.status === 404) return { notDeployed: true, ok: false, polling: false }
    return await safeJson(resp)
  } catch (err) {
    return { ok: false, polling: false, error: err.message }
  }
}

/**
 * Stop a bot's long-polling worker (e.g. when switching a bot over to
 * webhook mode from the roster).
 *   POST /telegram-pro/polling/stop { bot_id } -> { ok }
 * @param {string} botId
 * @returns {Promise<object>} result, or { notDeployed: true } on 404
 */
export async function stopPolling(botId) {
  try {
    const resp = await fetch('/collector/telegram-pro/polling/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ bot_id: botId || undefined }),
    })
    if (resp.status === 404) return { notDeployed: true, ok: false }
    return await safeJson(resp)
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * Which bots currently have a polling worker running. Shape may vary by
 * backend version; callers should only rely on `pollers` being an array of
 * objects that carry a `bot_id`. Used by the roster to derive an ingest-mode
 * pill (Polling / Webhook / Not connected) per bot.
 *   GET /telegram-pro/polling/status -> { pollers: [{ bot_id, mode }], ... }
 * @returns {Promise<object>} result, or { notDeployed: true, pollers: [] } on 404
 */
export async function getPollingStatus() {
  try {
    const resp = await fetch('/collector/telegram-pro/polling/status', { credentials: 'include' })
    if (resp.status === 404) return { notDeployed: true, pollers: [] }
    if (!resp.ok) return { pollers: [], error: `HTTP ${resp.status}` }
    const data = await safeJson(resp)
    return { pollers: [], ...data }
  } catch (err) {
    return { pollers: [], error: err.message }
  }
}

/** Best-guess default webhook URL: same-origin /collector proxy, matching
 * the existing /collector/webhook/telegram/* fetch convention used
 * throughout the dashboard (see coreCommsService.js). Editable by the
 * operator if their public origin differs. */
export function guessWebhookUrl() {
  if (typeof window === 'undefined') return ''
  return `${window.location.origin}/collector/webhook/telegram`
}

export default {
  saveBotToken,
  setupWebhook,
  getWebhookInfo,
  getOnboardingStatus,
  getBots,
  bindChat,
  bindOwnerChat,
  guessWebhookUrl,
  startPolling,
  stopPolling,
  getPollingStatus,
}
