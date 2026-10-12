/**
 * CAPTCHA / bot-detection action gate (task #127) — provider-agnostic
 * server-side token verifier. OFF BY DEFAULT: this module only runs when a
 * widget's embed_config_json.bot_protection.enabled === true (wiring lives
 * in routes/quoxchat.js, not here).
 *
 * verifyCaptchaToken() POSTs the visitor-minted token to the provider's
 * fixed, hardcoded siteverify endpoint — never a user/config-supplied URL,
 * so there is no SSRF surface here (unlike egress-guarded connector calls
 * elsewhere in QuoxChat). Fails CLOSED (ok:false) on any network error,
 * timeout, non-2xx response, or malformed body — an unreachable provider
 * must never silently grant human verification.
 */

'use strict';

const SITEVERIFY_URLS = Object.freeze({
  recaptcha_v3: 'https://www.google.com/recaptcha/api/siteverify',
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
});

const DEFAULT_MIN_SCORE = 0.5;
const VERIFY_TIMEOUT_MS = 5000;

/**
 * @param {object} opts
 * @param {'recaptcha_v3'|'turnstile'} opts.provider
 * @param {string} opts.token         The per-message token minted client-side.
 * @param {string} opts.secret        The widget's provider secret key (server-side only).
 * @param {string} [opts.remoteip]    Visitor IP, forwarded as a hint (optional, providers accept its absence).
 * @param {number} [opts.min_score]   reCAPTCHA v3 only — score threshold, default 0.5. Ignored by Turnstile (pass/fail only).
 * @param {string} [opts.expectedAction] reCAPTCHA v3 only — if the provider echoes an `action`, mismatches are rejected.
 * @returns {Promise<{ok: boolean, score: number|null, reason: string}>}
 */
async function verifyCaptchaToken({ provider, token, secret, remoteip, min_score, expectedAction } = {}) {
  const siteverifyUrl = SITEVERIFY_URLS[provider];
  if (!siteverifyUrl) {
    return { ok: false, score: null, reason: `unknown_provider:${provider}` };
  }
  if (!secret || typeof secret !== 'string') {
    return { ok: false, score: null, reason: 'no_secret_configured' };
  }
  if (!token || typeof token !== 'string') {
    return { ok: false, score: null, reason: 'missing_token' };
  }

  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);
  if (typeof remoteip === 'string' && remoteip) body.set('remoteip', remoteip);

  let resp;
  try {
    resp = await fetch(siteverifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    // Network error / timeout — fail closed.
    return { ok: false, score: null, reason: `network_error:${String(err?.message || err).slice(0, 120)}` };
  }

  if (!resp.ok) {
    return { ok: false, score: null, reason: `siteverify_http_${resp.status}` };
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, score: null, reason: 'malformed_response' };
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, score: null, reason: 'malformed_response' };
  }

  if (data.success !== true) {
    const errorCodes = Array.isArray(data['error-codes']) ? data['error-codes'].join(',') : '';
    return { ok: false, score: null, reason: errorCodes ? `verify_failed:${errorCodes}` : 'verify_failed' };
  }

  if (provider === 'recaptcha_v3') {
    const score = typeof data.score === 'number' ? data.score : null;
    const threshold = Number.isFinite(min_score) ? min_score : DEFAULT_MIN_SCORE;
    if (typeof expectedAction === 'string' && expectedAction && typeof data.action === 'string' && data.action !== expectedAction) {
      return { ok: false, score, reason: `action_mismatch:${data.action}` };
    }
    if (score === null) {
      return { ok: false, score: null, reason: 'missing_score' };
    }
    if (score < threshold) {
      return { ok: false, score, reason: `score_below_threshold:${score}<${threshold}` };
    }
    return { ok: true, score, reason: 'ok' };
  }

  // turnstile — pass/fail only, no score.
  return { ok: true, score: null, reason: 'ok' };
}

module.exports = { verifyCaptchaToken, SITEVERIFY_URLS, DEFAULT_MIN_SCORE };
