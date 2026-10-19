'use strict';
/**
 * QUOXON lane S (B): provider 4xx handling for the OpenAI-style tool loop.
 *
 * 1. reasoning_effort + function tools. Some OpenAI reasoning models refuse function tools on
 *    /v1/chat/completions at their default reasoning effort:
 *      400 "Function tools with reasoning_effort are not supported for gpt-5.6-luna in
 *      /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort
 *      to 'none'." (param: reasoning_effort)   captured live 2026-10-14.
 *    The provider names the remedy, so it is detected from the error itself (never a model
 *    list the owner has to maintain): the round is retried once with reasoning_effort 'none'
 *    and the (endpoint, model) pair is remembered for the process, so later rounds and turns
 *    send it first. Only rounds that carry tools get it.
 * 2. Any other provider 4xx: a plain one-line message naming the provider, the model, the
 *    status and the provider's own reason, instead of a truncated raw JSON body.
 */

const NEEDS_EFFORT_NONE = new Set();
const keyOf = (apiUrl, model) => `${String(apiUrl || '')}|${String(model || '')}`;

function parseProviderError(text) {
  const raw = typeof text === 'string' ? text : '';
  try {
    const j = JSON.parse(raw);
    const e = j && (j.error || j);
    if (e && typeof e === 'object') {
      return {
        message: typeof e.message === 'string' ? e.message : (typeof j.message === 'string' ? j.message : ''),
        param: typeof e.param === 'string' ? e.param : null,
        type: typeof e.type === 'string' ? e.type : null,
      };
    }
    if (typeof e === 'string') return { message: e, param: null, type: null };
  } catch { /* not JSON */ }
  return { message: raw.replace(/\s+/g, ' ').trim(), param: null, type: null };
}

/** True when this 4xx is the "function tools need reasoning_effort none" refusal. */
function isReasoningEffortToolsRefusal(status, text) {
  if (status !== 400) return false;
  const p = parseProviderError(text);
  const mentionsEffort = p.param === 'reasoning_effort' || /reasoning_effort/i.test(p.message);
  return mentionsEffort && /\b(function|tool)s?\b/i.test(p.message);
}

function rememberNeedsEffortNone(apiUrl, model) { NEEDS_EFFORT_NONE.add(keyOf(apiUrl, model)); }
function needsEffortNone(apiUrl, model) { return NEEDS_EFFORT_NONE.has(keyOf(apiUrl, model)); }

/** Apply the learned setting to one request body (only when it sends tools). Mutates body. */
function applyToolCompat(body, apiUrl) {
  if (body && Array.isArray(body.tools) && body.tools.length > 0 && needsEffortNone(apiUrl, body.model) && body.reasoning_effort === undefined) {
    body.reasoning_effort = 'none';
  }
  return body;
}

/** "<Provider> refused the request for model <m> (HTTP <s>): <reason>" */
function plainProviderErrorMessage({ providerLabel = 'OpenAI', model, status, text }) {
  const p = parseProviderError(text);
  const reason = (p.message || `HTTP ${status}`).slice(0, 400);
  const who = model ? ` for model ${model}` : '';
  if (status >= 400 && status < 500) return `${providerLabel} refused the request${who} (HTTP ${status}): ${reason}`;
  return `${providerLabel} failed${who} (HTTP ${status}): ${reason}`;
}

function _resetForTests() { NEEDS_EFFORT_NONE.clear(); }

module.exports = {
  parseProviderError,
  isReasoningEffortToolsRefusal,
  rememberNeedsEffortNone,
  needsEffortNone,
  applyToolCompat,
  plainProviderErrorMessage,
  _resetForTests,
};
