/**
 * Channel Reply Router — CORECOMMS-LOOP
 *
 * Bidirectional half of the channel bridge: when a human answers an inbox
 * item that originated from an external channel (a Telegram/Slack
 * unknown-sender escalation — see telegramWebhook.js/slackWebhook.js
 * createInboxItem, payload.source + chat_id/slack_user_id), the auth
 * service's inbox respond route (routes/inbox.js) fire-and-forget POSTs
 * here with the resolved channel_type/external_id and the human's reply
 * text. This module dispatches that text back out through the matching
 * channel driver (notificationService -> channels/registry.js ->
 * drivers/telegram.js|slack.js) so it lands in the conversation the
 * visitor/user actually wrote from.
 *
 * Fail-soft + idempotent by design, mirroring toolResume.js/qlusterDelegate.js's
 * resume-endpoint idiom: service-key guarded, responds 202 immediately, and
 * the actual channel send runs async so a slow/unreachable channel API can
 * never block or fail the human's inbox response. A per-item-id dedupe guard
 * (bounded, TTL-evicted) stops a duplicate dispatch (e.g. a retried call)
 * from sending the same reply twice.
 */

'use strict';

const VALID_CHANNEL_TYPES = new Set(['telegram', 'slack']);
const DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 minutes — comfortably longer than any retry window
const DEDUPE_MAX_ENTRIES = 2000;

const _recentlySent = new Map(); // item_id -> sentAtMs

/**
 * Returns true if this item_id was already dispatched inside the dedupe
 * window (and records this attempt if not). Lazily evicts stale entries so
 * the map never grows unbounded on a long-running process.
 */
function _isDuplicate(itemId) {
  if (!itemId) return false;
  const now = Date.now();
  for (const [key, ts] of _recentlySent) {
    if (now - ts > DEDUPE_TTL_MS) _recentlySent.delete(key);
  }
  if (_recentlySent.has(itemId)) return true;
  if (_recentlySent.size >= DEDUPE_MAX_ENTRIES) {
    const oldestKey = _recentlySent.keys().next().value;
    if (oldestKey !== undefined) _recentlySent.delete(oldestKey);
  }
  _recentlySent.set(itemId, now);
  return false;
}

/** Test-only escape hatch: clear the dedupe cache between test files. */
function _clearDedupeForTest() {
  _recentlySent.clear();
}

/**
 * Build the in-process dispatcher.
 *
 * @param {object} deps
 * @param {Function} deps.sendNotification - notificationService.sendNotification({channel, recipient, message, title, priority, orgId})
 * @param {Function} [deps.getConversation] - channelConversationStore.getConversation(channelType, externalId) — best-effort enrichment only, never required for the send to proceed
 * @returns {Function} async runChannelReply({ itemId, orgId, channelType, externalId, text })
 */
function createChannelReplyHandler(deps = {}) {
  const { sendNotification, getConversation } = deps;

  return async function runChannelReply(params = {}) {
    const itemId = params.itemId != null ? String(params.itemId) : '';
    const channelType = params.channelType;
    const externalId = params.externalId !== undefined && params.externalId !== null ? String(params.externalId) : '';
    const text = typeof params.text === 'string' ? params.text : '';
    const orgId = params.orgId || null;

    if (!VALID_CHANNEL_TYPES.has(channelType)) {
      return { ok: false, reason: 'unsupported_channel_type' };
    }
    if (!externalId) {
      return { ok: false, reason: 'missing_external_id' };
    }
    if (!text.trim()) {
      return { ok: false, reason: 'empty_text' };
    }
    if (typeof sendNotification !== 'function') {
      return { ok: false, reason: 'reply_not_configured' };
    }

    // Idempotency: never send the same inbox item's reply twice.
    if (_isDuplicate(itemId)) {
      return { ok: true, noop: true, status: 'already_sent' };
    }

    // Best-effort enrichment from the durable channel-threading table.
    // Never required and never blocks the send — a lookup miss or a store
    // failure just means we send without it (fail-soft, same contract as
    // every other channelConversationStore caller).
    if (typeof getConversation === 'function') {
      try {
        getConversation(channelType, externalId);
      } catch (err) {
        console.warn('[ChannelReplyRouter] channel_conversations lookup failed (non-fatal):', err && err.message);
      }
    }

    try {
      const result = await sendNotification({
        channel: channelType,
        recipient: externalId,
        title: null,
        message: text,
        priority: 'normal',
        orgId,
      });
      if (!result || result.success !== true) {
        console.error(`[ChannelReplyRouter] send failed for item ${itemId} (${channelType}:${externalId}):`, result && result.error);
        return { ok: false, reason: 'send_failed', error: result && result.error };
      }
      return { ok: true, status: 'sent' };
    } catch (err) {
      console.error(`[ChannelReplyRouter] send threw for item ${itemId} (${channelType}:${externalId}):`, err && err.message);
      return { ok: false, reason: 'send_threw', error: err && err.message };
    }
  };
}

/**
 * Internal endpoint factory. Service-key guarded (same convention as
 * toolResume.js's createResumeEndpoint / qlusterDelegate.js's
 * createResumeEndpoint) — the auth service calls this fire-and-forget after
 * a human responds to a channel-originated inbox item. Responds 202
 * immediately; the actual send runs async so a slow channel API never
 * blocks the caller.
 *
 * @param {object} deps
 * @param {Function} deps.sendNotification
 * @param {Function} [deps.getConversation]
 * @param {string} [deps.serviceKey]
 */
function createChannelReplyEndpoint(deps = {}) {
  const { serviceKey = process.env.INTERNAL_SERVICE_KEY || '' } = deps;
  const runChannelReply = createChannelReplyHandler(deps);

  return function channelReplyEndpoint(req, res) {
    if (serviceKey) {
      const provided = req.headers['x-service-key'] || '';
      if (provided !== serviceKey) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const body = req.body || {};
    const itemId = body.item_id;
    const channelType = body.channel_type;
    const externalId = body.external_id;
    const text = body.text;
    const orgId = body.org_id;

    if (!itemId || typeof itemId !== 'string') {
      return res.status(400).json({ error: 'item_id_required' });
    }
    if (!channelType || externalId === undefined || externalId === null || externalId === '') {
      return res.status(400).json({ error: 'channel_type_and_external_id_required' });
    }

    Promise.resolve()
      .then(() => runChannelReply({ itemId, orgId, channelType, externalId, text }))
      .catch((err) => console.warn('[ChannelReplyRouter] failed (non-fatal):', err && err.message));

    return res.status(202).json({ accepted: true, item_id: itemId });
  };
}

module.exports = {
  createChannelReplyHandler,
  createChannelReplyEndpoint,
  VALID_CHANNEL_TYPES,
  _clearDedupeForTest,
};
