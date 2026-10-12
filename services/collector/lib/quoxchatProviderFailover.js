/**
 * QuoxChat provider failover — QUOXCHAT-BRUTALOOP (2026-10-09)
 *
 * The corpus and the Standard tier promise provider failover; the wave-1
 * audit proved /message had none (a provider 5xx went straight to the
 * handoff belt or an error). Raise the code to the claim. Pure decisions:
 * which providers to try, in what order, and when a retry is safe.
 */

const AUTO_ORDER = ['openai', 'anthropic', 'gemini'];
// A configured widget-level OpenAI-compatible endpoint joins the chain only
// when keys.openai_compatible is truthy, i.e. the widget configured it.
const COMPAT = 'openai_compatible';

function failoverOrder({ primary, keys = {}, enabled = true, order: configured = null } = {}) {
  const chain = [];
  if (primary && keys[primary]) chain.push(primary);
  if (!enabled) return chain;
  // Privacy: a widget answering on a self-hosted model must not silently spill
  // visitor text to a cloud vendor. Failing over away from it needs an explicit
  // operator-written order (llm_failover_order).
  const explicit = Array.isArray(configured) && configured.length > 0;
  if (primary === COMPAT && !explicit) return chain;
  const rest = explicit ? configured : [...AUTO_ORDER, COMPAT];
  for (const p of rest) {
    if ((AUTO_ORDER.includes(p) || p === COMPAT) && p !== primary && keys[p] && !chain.includes(p)) chain.push(p);
  }
  return chain;
}

/**
 * Per-widget provider cooldowns: a provider that just failed with a
 * retryable error is skipped as primary for `ms`, so an outage costs one
 * failed call per widget per window instead of one per visitor message.
 * In-process by design (a cooldown is a few seconds of operational state,
 * not data); the evidence of every fallback is in the AEE trail.
 */
function createProviderCooldowns({ ms = 60000, now = () => Date.now() } = {}) {
  const until = new Map(); // `${widget}|${provider}` -> ts
  const key = (w, p) => `${w}|${p}`;
  function mark(widgetId, provider) { until.set(key(widgetId, provider), now() + ms); }
  function isCooling(widgetId, provider) {
    const t = until.get(key(widgetId, provider));
    if (!t) return false;
    if (t <= now()) { until.delete(key(widgetId, provider)); return false; }
    return true;
  }
  function pickPrimary(widgetId, chain) {
    const list = Array.isArray(chain) ? chain : [];
    return list.find((p) => !isCooling(widgetId, p)) || list[0] || null;
  }
  function snapshot() {
    const cooling = {};
    for (const [k, t] of until) {
      if (t <= now()) continue;
      const p = k.split('|')[1];
      cooling[p] = (cooling[p] || 0) + 1;
    }
    return { degraded: Object.keys(cooling).length > 0, cooling };
  }
  return { mark, isCooling, pickPrimary, snapshot };
}

function isRetryableProviderError(err) {
  if (!err) return false;
  // A visitor who cancelled the turn is not an outage.
  if (err.code === 'client_aborted' || /^client_aborted/.test(String(err.message || ''))) return false;
  const status = Number(err.status);
  if (Number.isFinite(status) && status > 0) {
    return status === 429 || status === 408 || status >= 500;
  }
  if (err.name === 'TimeoutError') return true;
  if (err.name === 'AbortError' && /timeout/i.test(String(err.message || ''))) return true;
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(err.code)) return true;
  if (/fetch failed|network|socket hang up/i.test(String(err.message || ''))) return true;
  return false;
}

/**
 * A retry on another provider is only safe when nothing visible or
 * side-effecting happened yet: no tool executed (it would run twice) and no
 * token reached the visitor (the reply would splice two models).
 */
function mayFailOver(err, { toolExecutions = 0, streamedChars = 0 } = {}) {
  if (toolExecutions > 0 || streamedChars > 0) return false;
  return isRetryableProviderError(err);
}

// An account that is out of credit cannot answer at all. Telling the visitor
// the bot is "receiving a lot of requests" (what prod said on 2026-10-10 when
// its OpenAI account hit insufficient_quota) is false; say what is true.
const OUT_OF_CREDIT_RE = /insufficient_quota|no credits remaining|credit balance is too low|billing|payment required|quota exceeded/i;

function providerUnavailableReply(err) {
  if (!err) return null;
  const status = Number(err.status);
  const msg = String(err.message || '');
  if (status === 402 || OUT_OF_CREDIT_RE.test(msg)) {
    return { error: 'provider_unavailable', response: "Sorry, I can't answer right now because the AI service behind this chat is unavailable. Please try again later, or contact the team directly." };
  }
  if (status === 429) {
    return { error: 'rate_limited', response: "I'm getting more questions than I can answer right now. Please try again in a minute." };
  }
  return null;
}

module.exports = { AUTO_ORDER, failoverOrder, isRetryableProviderError, mayFailOver, createProviderCooldowns, providerUnavailableReply };
