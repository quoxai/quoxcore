'use strict';
/**
 * QUOXON: per-model request options for self-hosted models (Ollama, LM Studio, vLLM).
 *
 * A small table keyed by model family holds sensible defaults; the org's provider
 * credential can override them with a `model_options` field (object or JSON string):
 *   { "qwen3": { "think": true }, "qwen3:14b": { "keep_alive": "30m" } }
 * An exact model key wins over its family key, which wins over the table.
 *
 * Options (anything else is dropped):
 *   think            boolean   model thinking on/off (qwen3-style hybrid reasoners)
 *   reasoning_effort none|low|medium|high (gpt-oss)
 *   keep_alive       Ollama duration ("15m", "45s", "1h"), seconds, or -1
 *   num_ctx          context window, 512..262144
 *   tools            boolean   false = never send tools to this model
 *
 * Wire mapping, verified against Ollama 0.40.3 /v1/chat/completions on 2026-10-12
 * (qwen3:14b on the owner's Mac, read-only calls):
 *   - `think: false` is IGNORED on /v1 (reasoning still came back, 7.4 s for "say hi");
 *     `reasoning_effort: "none"` turns thinking off (0.4 s, no reasoning). So think:false
 *     is sent as reasoning_effort "none".
 *   - `keep_alive` IS honoured ("7m" moved /api/ps expires_at to now+7m).
 *   - `options.num_ctx` is IGNORED (/api/ps context_length stayed 32768). It is kept in the
 *     table (and reported as `unsent`) but not put on the wire; set the window on the
 *     Ollama host (OLLAMA_CONTEXT_LENGTH) or in a Modelfile.
 *   - A model without thinking 400s on reasoning_effort "low" ("does not support thinking"),
 *     so options are only ever sent for a matched family or an explicit override.
 * vLLM: Qwen3's documented switch is chat_template_kwargs.enable_thinking; gpt-oss takes
 * reasoning_effort. LM Studio: Qwen3's documented "/no_think" soft switch in the system
 * prompt; gpt-oss takes reasoning_effort. (vLLM and LM Studio mappings are from vendor
 * docs, not yet driven live here.) Hosted presets get nothing.
 */

const FAMILY_DEFAULTS = Object.freeze({
  qwen3: Object.freeze({ think: false, keep_alive: '15m', num_ctx: 16384 }),
  'gpt-oss': Object.freeze({ reasoning_effort: 'low', keep_alive: '15m', tools: true }),
});

const EFFORTS = new Set(['none', 'low', 'medium', 'high']);
const DURATION_RE = /^\d{1,6}(ms|s|m|h)$/;
const REASONING_MAX = 8000;

/** Normalise a model name to its base: drop registry/namespace path and tag, lowercase. */
function baseName(model) {
  if (typeof model !== 'string') return '';
  const s = model.trim().toLowerCase();
  if (!s) return '';
  const last = s.split('/').pop();
  return last.split(':')[0];
}

/** 'qwen3' | 'gpt-oss' | null */
function modelFamily(model) {
  const b = baseName(model);
  if (!b) return null;
  if (b === 'qwen3' || /^qwen3[-_]/.test(b)) return 'qwen3';
  if (b === 'gpt-oss' || /^gpt-oss[-_]/.test(b)) return 'gpt-oss';
  return null;
}

function sanitise(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.think === 'boolean') out.think = raw.think;
  if (typeof raw.tools === 'boolean') out.tools = raw.tools;
  if (typeof raw.reasoning_effort === 'string' && EFFORTS.has(raw.reasoning_effort.toLowerCase())) out.reasoning_effort = raw.reasoning_effort.toLowerCase();
  const ka = raw.keep_alive;
  if (typeof ka === 'string' && DURATION_RE.test(ka.trim())) out.keep_alive = ka.trim();
  else if (Number.isInteger(ka) && (ka === -1 || (ka >= 0 && ka <= 86400 * 7))) out.keep_alive = ka;
  if (Number.isInteger(raw.num_ctx) && raw.num_ctx >= 512 && raw.num_ctx <= 262144) out.num_ctx = raw.num_ctx;
  return out;
}

function parseOverrides(overrides) {
  if (typeof overrides === 'string') {
    try { overrides = JSON.parse(overrides); } catch { return {}; }
  }
  return overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
}

/** Defaults for the model's family, then the credential's family key, then its exact model key. */
function resolveModelOptions(model, overrides) {
  const fam = modelFamily(model);
  const ov = parseOverrides(overrides);
  const name = typeof model === 'string' ? model.trim() : '';
  const exact = name && (ov[name] || ov[name.toLowerCase()]);
  return {
    ...(fam ? FAMILY_DEFAULTS[fam] : {}),
    ...(fam ? sanitise(ov[fam]) : {}),
    ...sanitise(exact),
  };
}

/**
 * Options -> what goes on the wire for this provider.
 * -> { body: {...extra request fields}, systemSuffix: string, toolsOff: boolean, unsent: string[] }
 */
function requestExtrasFor(provider, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const body = {};
  const unsent = [];
  let systemSuffix = '';
  const p = String(provider || '').toLowerCase();
  if (p === 'ollama') {
    if (o.reasoning_effort) body.reasoning_effort = o.reasoning_effort;
    else if (o.think === false) body.reasoning_effort = 'none';
    if (o.keep_alive !== undefined) body.keep_alive = o.keep_alive;
    if (o.num_ctx !== undefined) unsent.push('num_ctx');
  } else if (p === 'vllm') {
    if (o.reasoning_effort) body.reasoning_effort = o.reasoning_effort;
    else if (o.think === false) body.chat_template_kwargs = { enable_thinking: false };
    if (o.keep_alive !== undefined) unsent.push('keep_alive');
    if (o.num_ctx !== undefined) unsent.push('num_ctx');
  } else if (p === 'lmstudio') {
    if (o.reasoning_effort) body.reasoning_effort = o.reasoning_effort;
    else if (o.think === false) systemSuffix = '/no_think';
    if (o.keep_alive !== undefined) unsent.push('keep_alive');
    if (o.num_ctx !== undefined) unsent.push('num_ctx');
  } else {
    for (const k of Object.keys(o)) unsent.push(k);
  }
  return { body, systemSuffix, toolsOff: o.tools === false, unsent };
}

/** Preset extras first (never overridden), then model options. undefined when empty. */
function mergeExtraBody(presetExtra, modelBody) {
  const out = { ...(modelBody || {}), ...(presetExtra || {}) };
  return Object.keys(out).length ? out : undefined;
}

/** Append a soft switch (e.g. "/no_think") to a system prompt. */
function withSystemSuffix(prompt, suffix) {
  if (!suffix) return prompt;
  return `${prompt || ''}\n\n${suffix}`.trimStart();
}

/**
 * The client event for a model's reasoning text: a dim, collapsed "thinking" stage.
 * The answer never carries it. -> event | null
 */
function reasoningStageEvent(text, { agent = 'QUOX', round = 0 } = {}) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return null;
  return {
    type: 'thinking',
    agent,
    stage: 'model_reasoning',
    message: `thinking (${t.length} chars)`,
    reasoning: t.length > REASONING_MAX ? `${t.slice(0, REASONING_MAX)}…` : t,
    collapsed: true,
    round,
  };
}

/** Everything a provider turn needs from the table, in one call. */
function modelTurnOptions(provider, model, overrides) {
  const options = resolveModelOptions(model, overrides);
  return { family: modelFamily(model), options, ...requestExtrasFor(provider, options) };
}

module.exports = {
  FAMILY_DEFAULTS,
  modelFamily,
  resolveModelOptions,
  requestExtrasFor,
  mergeExtraBody,
  withSystemSuffix,
  reasoningStageEvent,
  modelTurnOptions,
};
