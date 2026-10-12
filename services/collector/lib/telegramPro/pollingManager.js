/**
 * Telegram Long-Polling Worker, QTG-PRO.
 *
 * Self-hosted ingestion path: a box with no domain and no public IP still
 * receives Telegram updates by pulling them outbound via getUpdates,
 * instead of Telegram pushing them in via a webhook. This is the polling
 * default for QTG-PRO. Every update pulled here is handed to the exact
 * same processTelegramUpdate() core the webhook handler uses
 * (lib/telegramWebhook.js), so both ingestion paths behave identically
 * downstream — dedup, seen-chat recording, forum sync, binding routing,
 * commands, and agent-pipeline dispatch are all shared, not reimplemented.
 *
 * Polling is at-least-once by construction (an update can be re-delivered
 * after an unclean restart, before its offset was persisted). This is
 * safe: processTelegramUpdate runs updateDedup.seenBefore on every update
 * regardless of which ingestion path called it, so a replayed update_id is
 * inert whether it arrives via webhook retry or a polling redelivery.
 */

'use strict';

const telegramProStore = require('./telegramProStore');
const { processTelegramUpdate } = require('../telegramWebhook.js');

const DEFAULT_POLL_TIMEOUT_S = 30; // Telegram long-poll wait, seconds
const REQUEST_TIMEOUT_MS = 35_000; // must exceed the long-poll wait above
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'message_reaction'];

// One loop-state entry per botId. Not module-reloadable across test files
// on its own — tests should call stopPolling for every botId they start.
const _loops = new Map();

/**
 * Real Telegram Bot API caller, used when no api function is injected.
 * Long-poll aware: the HTTP request timeout (35s) exceeds Telegram's own
 * getUpdates wait (30s) so a slow-but-legitimate empty long-poll response
 * is never mistaken for a network failure.
 */
async function defaultApi(token, method, params = {}) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await resp.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(`Telegram API ${method} failed: ${data.description || resp.status}`);
    err.httpStatus = resp.status;
    err.description = data.description;
    throw err;
  }
  return data.result;
}

/**
 * getUpdates and a webhook cannot coexist on the same bot (Telegram
 * rejects getUpdates with a 409 while a webhook URL is set). Called once
 * before a bot's first poll, and again reactively if a 409 slips through
 * (e.g. a webhook was (re)registered externally after polling started).
 */
async function deleteWebhook(token, { api = defaultApi } = {}) {
  try {
    await api(token, 'deleteWebhook', {});
    console.log('[TelegramPolling] deleteWebhook called (getUpdates and a webhook cannot coexist)');
    return true;
  } catch (err) {
    console.error(`[TelegramPolling] deleteWebhook failed, ${err.message}`);
    return false;
  }
}

function isConflict409(err) {
  return !!err && (err.httpStatus === 409 || /Conflict/i.test(err.message || ''));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runLoop({ botId, token, deps, config, api, dbPath, state }) {
  await deleteWebhook(token, { api });

  let offset = telegramProStore.getOffset({ botId, dbPath });
  let backoff = BACKOFF_START_MS;

  while (!state.stopped) {
    let updates;
    try {
      const params = { timeout: DEFAULT_POLL_TIMEOUT_S, allowed_updates: ALLOWED_UPDATES };
      if (offset !== null && offset !== undefined) params.offset = offset;

      updates = await api(token, 'getUpdates', params);
      backoff = BACKOFF_START_MS; // reset after any successful call
    } catch (err) {
      if (state.stopped) break;
      if (isConflict409(err)) {
        console.warn(`[TelegramPolling] ${botId}: 409 conflict (webhook active), deleting webhook and retrying`);
        await deleteWebhook(token, { api });
        continue;
      }
      console.error(`[TelegramPolling] ${botId}: getUpdates failed, backing off ${backoff}ms, ${err.message}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
      continue;
    }

    for (const update of (updates || [])) {
      if (state.stopped) break;
      try {
        await processTelegramUpdate(update, { botId, config, deps });
      } catch (err) {
        // Never let a single bad update wedge the loop forever — log and
        // advance past it. Dedup is the backstop, not infinite retry.
        console.error(`[TelegramPolling] ${botId}: processTelegramUpdate threw, ${err.message}`);
      }
      offset = update.update_id + 1;
      telegramProStore.setOffset({ botId, offset, dbPath });
    }
  }

  state.running = false;
}

/**
 * Starts one long-poll loop for a bot. Idempotent: calling again for a
 * botId that already has a loop running returns the existing state without
 * starting a second loop.
 *
 * @param {object} opts
 * @param {string} opts.botId
 * @param {string} opts.token - bot API token
 * @param {object} [opts.deps] - forwarded to processTelegramUpdate as ctx.deps
 *   (resolveUser, routeToChatPipeline, sendReply, storeAuditEnvelope, etc.)
 * @param {object} [opts.config] - forwarded to processTelegramUpdate as
 *   ctx.config (bot_username, default_org_id, default_agent, org_id)
 * @param {Function} [opts.api] - injectable api(token, method, params),
 *   defaults to the real Telegram Bot API over fetch
 * @param {string} [opts.dbPath] - injectable offset-store db path (tests)
 * @returns {{botId: string, stopped: boolean, running: boolean, promise: Promise}}
 */
function startPolling({ botId, token, deps = {}, config = {}, api = defaultApi, dbPath } = {}) {
  if (!botId) throw new Error('startPolling requires botId');
  if (!token) throw new Error('startPolling requires token');

  const existing = _loops.get(botId);
  if (existing) return existing;

  const state = { botId, stopped: false, running: true };
  state.promise = runLoop({ botId, token, deps, config, api, dbPath, state });
  _loops.set(botId, state);
  return state;
}

/**
 * Signals a bot's poll loop to stop. The loop exits at its next checkpoint
 * (top of the while, or right after its current getUpdates/backoff
 * settles) — it does not abort an in-flight getUpdates call.
 *
 * @returns {boolean} true if a loop was found for botId, false otherwise.
 */
function stopPolling({ botId } = {}) {
  const state = _loops.get(botId);
  if (!state) return false;
  state.stopped = true;
  _loops.delete(botId);
  return true;
}

/** @returns {boolean} true if a live (non-stopped) loop exists for botId. */
function isPolling({ botId } = {}) {
  const state = _loops.get(botId);
  return !!(state && !state.stopped);
}

/** @returns {Array<{bot_id: string}>} every bot with a live poll loop. */
function listPolling() {
  return Array.from(_loops.values())
    .filter(s => !s.stopped)
    .map(s => ({ bot_id: s.botId }));
}

/**
 * Boot-time auto-start: resumes polling for every bot with a persisted
 * mode='polling' row (telegram_bot_ingest) and a resolvable token.
 * Fire-and-forget: never throws, never blocks collector boot, no-ops when
 * no bots are configured for polling yet (fresh install).
 *
 * @param {object} [opts]
 * @param {object} [opts.deps] - forwarded to each startPolling call
 * @param {Function} [opts.getWebhookConfig] - injectable config resolver,
 *   defaults to telegramWebhook.js's real getWebhookConfig
 * @param {string} [opts.dbPath] - injectable offset/mode-store db path (tests)
 */
async function startConfiguredPollers({ deps = {}, getWebhookConfig, dbPath } = {}) {
  try {
    const modes = telegramProStore.listModes({ dbPath });
    const pollingBots = modes.filter(m => m.mode === 'polling');
    if (pollingBots.length === 0) return;

    const _getConfig = getWebhookConfig || require('../telegramWebhook.js').getWebhookConfig;

    for (const { bot_id: botId } of pollingBots) {
      try {
        const config = await _getConfig(botId === 'default' ? undefined : botId);
        if (!config || !config.bot_token) {
          console.warn(`[TelegramPolling] ${botId}: mode=polling but no token resolvable, skipping boot auto-start`);
          continue;
        }
        startPolling({ botId, token: config.bot_token, deps, config, dbPath });
        console.log(`[TelegramPolling] ${botId}: resumed polling on boot`);
      } catch (err) {
        console.error(`[TelegramPolling] ${botId}: boot auto-start failed, ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[TelegramPolling] startConfiguredPollers failed:', err.message);
  }
}

module.exports = {
  startPolling,
  stopPolling,
  isPolling,
  listPolling,
  startConfiguredPollers,
  deleteWebhook,
  _internals: { defaultApi, isConflict409 },
};
