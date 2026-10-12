/**
 * QCX-8b — Pure helpers for outbound webhook event filtering.
 *
 * matchesSubscription(eventName, subscription)
 *   subscription forms:
 *     '*'                           — wildcard all
 *     'message.created'             — exact
 *     'message.*'                   — prefix wildcard
 *     ['message.*', 'handoff.*']    — array of any of the above
 *
 * buildWebhookPayload(eventName, data) → canonical payload shape
 *   { id: 'evt_<rand>', event, created_at, widget_id, data }
 */

'use strict';

const crypto = require('crypto');

function _matchSingle(eventName, sub) {
  if (sub === '*') return true;
  if (typeof sub !== 'string') return false;
  if (sub.endsWith('.*')) {
    const prefix = sub.slice(0, -1); // 'message.*' -> 'message.'
    return eventName.startsWith(prefix);
  }
  return sub === eventName;
}

function matchesSubscription(eventName, subscription) {
  if (typeof eventName !== 'string') return false;
  if (subscription == null) return false;
  if (Array.isArray(subscription)) {
    return subscription.some(s => _matchSingle(eventName, s));
  }
  return _matchSingle(eventName, subscription);
}

function buildWebhookPayload(eventName, data) {
  const random = crypto.randomBytes(8).toString('hex');
  return {
    id: `evt_${random}`,
    event: eventName,
    created_at: new Date().toISOString(),
    widget_id: (data && data.widget_id) || null,
    data: data || {},
  };
}

module.exports = { matchesSubscription, buildWebhookPayload };
