/**
 * MON-GOV-3: SIEM outbound dispatcher.
 *
 * Fire-and-forget delivery of governance incidents to configured
 * webhooks. Handles format selection, auth, retry with exponential
 * backoff on 5xx, and a circuit breaker that auto-disables a webhook
 * after too many consecutive failures.
 *
 * Every delivery stamps last_delivery_at, last_status, last_error, and
 * consecutive_failures on the config row so ops can triage via the
 * webhook list view.
 */

const { bodyFor } = require('./governanceEventFormatter.js');
const { getMatchingWebhooks, updateWebhook } = require('./governanceWebhookConfig.js');
const { hmacSign, validateOutboundUrl } = require('./channels/baseDriver.js');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;

// Circuit breaker: disable a webhook after this many consecutive full
// failure rounds (each round may itself include retries).
const CIRCUIT_BREAKER_THRESHOLD = 10;

function nowIso() {
  return new Date().toISOString();
}

function buildHeaders(cfg, body) {
  const headers = {
    'Content-Type': cfg._contentType || 'application/json',
    'X-Quox-Timestamp': nowIso(),
    'X-Quox-Source': 'quox-governance',
  };
  switch (cfg.auth_scheme) {
    case 'bearer':
      if (cfg.auth_secret) headers.Authorization = `Bearer ${cfg.auth_secret}`;
      break;
    case 'basic':
      if (cfg.auth_secret) headers.Authorization = `Basic ${cfg.auth_secret}`;
      break;
    case 'hmac':
      if (cfg.auth_secret) {
        headers['X-Quox-Signature'] = `sha256=${hmacSign(body, cfg.auth_secret)}`;
      }
      break;
    default:
      break;
  }
  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a single incident to a single webhook with retry on 5xx.
 * Returns { ok, status, error, attempts }.
 */
async function deliverToWebhook(cfg, incident, options = {}) {
  const {
    fetchFn = globalThis.fetch,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  } = options;

  if (!cfg || !cfg.target_url) {
    return { ok: false, status: 0, error: 'missing target_url', attempts: 0 };
  }

  const urlCheck = validateOutboundUrl(cfg.target_url);
  if (!urlCheck.valid) {
    return { ok: false, status: 0, error: `url_blocked:${urlCheck.error}`, attempts: 0 };
  }

  const { body, contentType } = bodyFor(cfg.format || 'generic_json', incident);
  const taggedCfg = { ...cfg, _contentType: contentType };
  const headers = buildHeaders(taggedCfg, body);

  let lastStatus = 0;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetchFn(cfg.target_url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = resp.status;
      if (resp.ok) {
        return { ok: true, status: resp.status, error: null, attempts: attempt };
      }
      // 4xx — do not retry, the config is wrong.
      if (resp.status >= 400 && resp.status < 500) {
        lastError = `http_${resp.status}`;
        return { ok: false, status: resp.status, error: lastError, attempts: attempt };
      }
      // 5xx — retry with backoff unless we're out of attempts.
      lastError = `http_${resp.status}`;
    } catch (err) {
      lastStatus = 0;
      lastError = err?.message || 'network_error';
    }

    if (attempt < maxAttempts) {
      await sleep(backoffBaseMs * Math.pow(2, attempt - 1));
    }
  }

  return { ok: false, status: lastStatus, error: lastError, attempts: maxAttempts };
}

/**
 * Persist delivery outcome + bump the circuit-breaker counters. Auto-
 * disables the webhook if consecutive_failures crosses the threshold.
 */
function recordDelivery(db, cfg, result) {
  const nextConsecutive = result.ok ? 0 : (cfg.consecutive_failures || 0) + 1;

  const patch = {
    last_delivery_at: nowIso(),
    last_status: result.status || null,
    last_error: result.ok ? null : result.error,
    consecutive_failures: nextConsecutive,
  };

  if (!result.ok && nextConsecutive >= CIRCUIT_BREAKER_THRESHOLD) {
    patch.enabled = false;
    patch.last_error = `${result.error} (circuit breaker opened at ${nextConsecutive} consecutive failures)`;
  }

  try {
    updateWebhook(db, cfg.id, patch);
  } catch (err) {
    console.warn('[MON-GOV] webhook state update failed:', err.message);
  }
}

/**
 * Fan out a single incident to every matching enabled webhook. Each
 * delivery runs independently; one failure does not block the others.
 * Returns an array of { webhook_id, ok, status, attempts, error }.
 */
async function dispatchIncident(db, incident, options = {}) {
  if (!db || !incident) return [];

  const matches = getMatchingWebhooks(db, incident);
  if (matches.length === 0) return [];

  const results = [];
  await Promise.all(matches.map(async (cfg) => {
    const r = await deliverToWebhook(cfg, incident, options);
    if (db !== null) recordDelivery(db, cfg, r);
    results.push({
      webhook_id: cfg.id,
      ok: r.ok,
      status: r.status,
      attempts: r.attempts,
      error: r.error,
    });
  }));
  return results;
}

module.exports = {
  CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  deliverToWebhook,
  dispatchIncident,
  recordDelivery,
  buildHeaders, // exported for tests
};
