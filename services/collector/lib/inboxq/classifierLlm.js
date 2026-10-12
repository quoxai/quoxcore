'use strict';

/**
 * InboxQ selectable classifier model (cost control) — builds the org-scoped
 * `llm(msg)` function classify.js consults on genuinely ambiguous mail (see
 * classify.js's AMBIGUOUS_THRESHOLD / llm contract, confirmed at classify.js
 * lines ~152-171: `llm` is an async fn (message) -> 'focus'|'fyi'|null,
 * called at most once per message, only when the rules are unsure).
 *
 * DETERMINISTIC-FIRST, OPT-IN, NEVER-FALLBACK: when an org has not picked a
 * model (inboxq_settings.classifier_model is NULL, the default), this
 * returns a `null` verdict fn with ZERO network calls — classify.js then
 * stands on the rule verdict, exactly as it did before this feature existed.
 * A stale/removed model id in settings also degrades to null, never to some
 * other (possibly expensive) default model — cost control is the entire
 * point of this setting.
 *
 * Pure DI over the collector's EXISTING model-invocation helpers (server.js's
 * attemptAnthropicApiInvoke — the same fn the /api/internal/agents/invoke
 * fast path calls — and a lightweight direct OpenAI single-shot call, since a
 * one-word classification needs no tool loop) so this never reinvents a
 * provider client. server.js supplies the real deps; tests supply fakes.
 *
 * The existing per-tick/per-sync LLM budget (perSyncLlmBudget /
 * llmBudgetPerTick, already enforced by classify.js's caller-supplied
 * `budget` object) is unchanged by this module — this only decides WHETHER
 * a call is attempted at all and with WHICH model, never how many.
 */

function parseInboxqClassifierVerdict(text) {
  const t = (text || '').toString().trim().toLowerCase();
  if (t.startsWith('focus')) return 'focus';
  if (t.startsWith('fyi')) return 'fyi';
  return null;
}

const DEFAULT_SYSTEM_PROMPT = 'You triage a single inbound email into exactly one zone: "focus" (a real person/business wanting something from a human) or "fyi" (lower-priority - newsletter, digest, bulk update). Reply with exactly one word: focus or fyi. No other text.';

function buildClassifierPrompt(msg) {
  const snippet = (msg?.snippet || '').toString().slice(0, 500);
  return `From: ${msg?.fromName || ''} <${msg?.fromAddr || ''}>\nSubject: ${msg?.subject || ''}\nSnippet: ${snippet}\n\nZone (focus or fyi)?`;
}

/**
 * @param {object} deps
 * @param {object} deps.store               inboxq store module (getSettings, AVAILABLE_CLASSIFIER_MODELS)
 * @param {Function} deps.getClaudeKeys      async (orgId) -> { anthropic_api_key, ... }
 * @param {Function} deps.getProviderKeys    async (orgId) -> { openai_api_key, ... }
 * @param {Function} deps.invokeAnthropic    async ({candidate,agentId,context,task,apiKey,maxTokens}) -> { result }
 *                                           (server.js's attemptAnthropicApiInvoke)
 * @param {Function} [deps.fetchImpl]        fetch impl for the OpenAI single-shot call (test override)
 * @param {string}   [deps.anthropicEnvKey]  process.env.ANTHROPIC_API_KEY fallback
 * @returns {Function} (orgId) -> async (msg) -> 'focus'|'fyi'|null — matches classify.js's llm contract
 */
function buildClassifierLlm(deps = {}) {
  const {
    store,
    getClaudeKeys,
    getProviderKeys,
    invokeAnthropic,
    fetchImpl = (typeof fetch === 'function' ? fetch : null),
    anthropicEnvKey = process.env.ANTHROPIC_API_KEY,
  } = deps;
  if (!store) throw new Error('buildClassifierLlm requires deps.store');

  return function buildForOrg(orgId) {
    return async function inboxqClassifierLlm(msg) {
      let settings;
      try {
        settings = store.getSettings(orgId);
      } catch {
        return null; // a settings-read failure must never break classification
      }
      // Disabled (the safe default): stay deterministic, no LLM call.
      if (!settings || !settings.classifierModel) return null;
      const modelEntry = (store.AVAILABLE_CLASSIFIER_MODELS || []).find((m) => m.id === settings.classifierModel);
      if (!modelEntry) return null; // a stale/removed setting value also stays deterministic

      const sysPrompt = DEFAULT_SYSTEM_PROMPT;
      const userPrompt = buildClassifierPrompt(msg);

      try {
        if (modelEntry.provider === 'anthropic') {
          if (typeof invokeAnthropic !== 'function' || typeof getClaudeKeys !== 'function') return null;
          const claudeKeys = await getClaudeKeys(orgId);
          const apiKey = claudeKeys?.anthropic_api_key || anthropicEnvKey;
          if (!apiKey) return null;
          const resp = await invokeAnthropic({
            candidate: { model: modelEntry.id },
            agentId: 'inboxq-classifier',
            context: sysPrompt,
            task: userPrompt,
            apiKey,
            maxTokens: 8,
          });
          return parseInboxqClassifierVerdict(resp?.result);
        }
        if (modelEntry.provider === 'openai') {
          if (typeof getProviderKeys !== 'function' || typeof fetchImpl !== 'function') return null;
          const providerKeys = await getProviderKeys(orgId);
          const apiKey = providerKeys?.openai_api_key;
          if (!apiKey) return null;
          const apiResp = await fetchImpl('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: modelEntry.id,
              max_tokens: 8,
              messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }],
            }),
            signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(15000) : undefined,
          });
          if (!apiResp.ok) return null;
          const data = await apiResp.json();
          return parseInboxqClassifierVerdict(data?.choices?.[0]?.message?.content);
        }
        return null;
      } catch (e) {
        // classify.js already wraps llm() in try/catch, but stay defensive
        // here too - a classifier LLM failure must never break ingestion.
        console.error('[inboxq] classifier llm invoke failed:', e?.message);
        return null;
      }
    };
  };
}

module.exports = { buildClassifierLlm, parseInboxqClassifierVerdict, buildClassifierPrompt };
