/**
 * QCX-8a — Pure outbound webhook signer + verifier.
 *
 * Format: header value `t=<unix>,v1=<sha256_hex>` over `<unix>.<body>`.
 * HMAC-SHA256 with a per-widget secret. Verifier rejects payloads older
 * than 5 minutes to defeat replay attacks. Same pattern as Stripe/GitHub
 * so partners can drop in existing webhook-verification snippets.
 */

'use strict';

const crypto = require('crypto');
const REPLAY_WINDOW_SECONDS = 5 * 60;

function _sign(secret, timestamp, body) {
  const payload = `${timestamp}.${body}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function signWebhookPayload({ secret, body, timestamp } = {}) {
  const ts = Number.isFinite(timestamp) ? Math.floor(timestamp) : Math.floor(Date.now() / 1000);
  const sig = _sign(secret, ts, body);
  return { timestamp: ts, signature: sig, header: `t=${ts},v1=${sig}` };
}

function _parseHeader(header) {
  if (typeof header !== 'string' || header.length === 0) return null;
  const parts = {};
  for (const piece of header.split(',')) {
    const m = piece.match(/^([a-z0-9]+)=(.+)$/i);
    if (m) parts[m[1]] = m[2];
  }
  if (!parts.t || !parts.v1) return null;
  const ts = parseInt(parts.t, 10);
  if (!Number.isFinite(ts)) return null;
  return { timestamp: ts, signature: parts.v1 };
}

function _safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }
  catch { return false; }
}

function verifyWebhookSignature({ secret, body, header, now } = {}) {
  const parsed = _parseHeader(header);
  if (!parsed) return { valid: false, reason: 'malformed signature header' };
  const nowSec = Number.isFinite(now) ? Math.floor(now) : Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.timestamp) > REPLAY_WINDOW_SECONDS) {
    return { valid: false, reason: 'signature stale (replay window expired)' };
  }
  const expected = _sign(secret, parsed.timestamp, body);
  if (!_safeEq(expected, parsed.signature)) {
    return { valid: false, reason: 'signature mismatch' };
  }
  return { valid: true };
}

module.exports = { signWebhookPayload, verifyWebhookSignature };
