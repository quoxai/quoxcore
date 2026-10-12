/**
 * QCX-8b — Outbound webhook delivery.
 *
 * Fire-and-forget contract: never throws, always resolves with a status
 * envelope. Caller (also fire-and-forget) doesn't need try/catch.
 *
 * Headers:
 *   Content-Type: application/json
 *   X-Quox-Event: <event-name>
 *   X-Quox-Signature: t=<unix>,v1=<hmac>
 */

'use strict';

const { signWebhookPayload } = require('./quoxchatWebhookSigner');

function _isSafeUrl(url) {
  if (typeof url !== 'string') return false;
  return /^https?:\/\//i.test(url);
}

async function deliverWebhook({ url, secret, payload, timeoutMs = 5000 } = {}) {
  if (!_isSafeUrl(url)) {
    return { ok: false, error: 'unsafe or invalid URL scheme' };
  }
  const body = JSON.stringify(payload || {});
  const signed = signWebhookPayload({ secret: secret || '', body });
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Quox-Signature': signed.header,
        'X-Quox-Event': payload?.event || 'unknown',
        'User-Agent': 'QuoxChat-Webhook/1.0',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: resp.ok, status: resp.status };
  } catch (err) {
    return { ok: false, error: err?.message || 'network error' };
  }
}

module.exports = { deliverWebhook };
