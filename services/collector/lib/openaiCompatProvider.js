'use strict';
/**
 * CLI-QUOX B5: one generic OpenAI-compatible /chat/stream provider (`openai_compatible`)
 * with presets. Every preset runs the SAME B1 governed loop (executeOpenAICompatibleToolLoop)
 * that OpenAI and Ollama (B3) use; this module owns what differs per preset:
 *
 *   - where it lives (a fixed vendor base URL, or a base URL from the org's credential)
 *   - the key (the org's DEFAULT QuoxVault credential of the preset's integration type)
 *   - egress (who may be called, and from where)
 *   - extra request headers/body (OpenRouter attribution and usage accounting)
 *   - model listing (<base>/models) and model choice
 *   - per-call cost (OpenRouter reports it; nobody else's cost is guessed)
 *   - the "this model does not support tools" retry (the Ollama pattern)
 *
 * Presets: openrouter, huggingface (Inference Providers router), groq, together (hosted,
 * key required, fixed base URL); lmstudio, vllm (self-hosted on the operator's LAN, base URL
 * from the credential, no key, or an optional key for vLLM --api-key); custom (any public
 * https base URL, optional key).
 *
 * EGRESS POLICY (read before changing):
 *   - Hosted presets (a third party in the data path): https only, and EVERY resolved address
 *     must be public. No private, CGNAT, loopback, link-local or reserved target, whatever the
 *     credential says. Custom is hosted: "your own server on the LAN" is what lmstudio/vllm are for.
 *   - Self-hosted presets: the Ollama rule (lib/ollamaProvider.js header), verbatim: public
 *     passes; private ranges (RFC1918, CGNAT 100.64/10, fc00::/7) pass ONLY for the exact origin
 *     written as allow_private_origin into the org's credential (auth additionally requires the
 *     instance gate allow_lan_integration_targets to store a LAN base_url); loopback, link-local,
 *     metadata and reserved ranges are ALWAYS blocked.
 *   - Redirects are never followed (redirect: 'manual'; a 3xx fails the call).
 * Residual (same as the other egress guards): DNS rebinding between resolve and connect is
 * not pinned.
 *
 * DATA PATH: hosted presets send prompts and tool results to a third party, so the stream
 * route gates them on the per-org AI data sharing consent (consentId below, listed in
 * lib/consentVerification.js and auth routes/consent.js). Self-hosted presets are the
 * operator's own servers (no consent gate, same as ollama and local).
 *
 * SECRETS: the key lives only in the object prepareCompatTurn returns (for the request
 * headers) and is never logged, echoed in a message, or returned by a route.
 */

const dnsPromises = require('node:dns/promises');
const net = require('node:net');
const { classifyIp, normaliseOrigin } = require('./quoxchatCompatLlm.js');
const { isLoopbackIp } = require('./ollamaProvider.js');

const PROVIDER_ID = 'openai_compatible';
const MAX_MODELS = 1000;
// Hosted models carry large context windows; self-hosted ones are often small.
const COMPAT_TOOL_CAP = 64;
const SELF_HOSTED_TOOL_CAP = 24;

const ATTRIBUTION_URL = () => {
  const u = String(process.env.QUOX_PUBLIC_URL || '').trim();
  return /^https:\/\//i.test(u) ? u : 'https://quox.ai';
};

/**
 * key: 'required' | 'optional' | 'none'. hosted: a third party in the data path.
 * url: the base URL comes from the credential (and the probe route serves the preset).
 */
const PRESETS = Object.freeze({
  openrouter: Object.freeze({
    id: 'openrouter', label: 'OpenRouter', vaultType: 'openrouter', keyField: 'api_key', key: 'required',
    hosted: true, url: false, baseUrl: 'https://openrouter.ai/api/v1', consentId: 'openrouter',
    costSource: 'openrouter',
    // OpenRouter app attribution (https://openrouter.ai/docs/api-reference/overview#headers).
    headers: () => ({ 'HTTP-Referer': ATTRIBUTION_URL(), 'X-Title': 'Quox' }),
    // Usage accounting: the final chunk's usage carries `cost` (credits, USD).
    extraBody: Object.freeze({ usage: Object.freeze({ include: true }) }),
  }),
  huggingface: Object.freeze({
    id: 'huggingface', label: 'Hugging Face', vaultType: 'huggingface', keyField: 'api_token', key: 'required',
    hosted: true, url: false, baseUrl: 'https://router.huggingface.co/v1', consentId: 'huggingface',
    costSource: null, headers: null, extraBody: null,
  }),
  groq: Object.freeze({
    id: 'groq', label: 'Groq', vaultType: 'groq', keyField: 'api_key', key: 'required',
    hosted: true, url: false, baseUrl: 'https://api.groq.com/openai/v1', consentId: 'groq',
    costSource: null, headers: null, extraBody: null,
  }),
  together: Object.freeze({
    id: 'together', label: 'Together AI', vaultType: 'together', keyField: 'api_key', key: 'required',
    hosted: true, url: false, baseUrl: 'https://api.together.xyz/v1', consentId: 'together',
    costSource: null, headers: null, extraBody: null,
  }),
  lmstudio: Object.freeze({
    id: 'lmstudio', label: 'LM Studio', vaultType: 'lmstudio', keyField: null, key: 'none',
    hosted: false, url: true, baseUrl: null, consentId: null, defaultPort: 1234,
    costSource: 'self_hosted', headers: null, extraBody: null,
  }),
  vllm: Object.freeze({
    id: 'vllm', label: 'vLLM', vaultType: 'vllm', keyField: 'api_key', key: 'optional',
    hosted: false, url: true, baseUrl: null, consentId: null, defaultPort: 8000,
    costSource: 'self_hosted', headers: null, extraBody: null,
  }),
  custom: Object.freeze({
    id: 'custom', label: 'Custom endpoint', vaultType: 'openai_compatible', keyField: 'api_key', key: 'optional',
    hosted: true, url: true, baseUrl: null, consentId: 'openai_compatible',
    costSource: null, headers: null, extraBody: null,
  }),
});
const ALIASES = Object.freeze({ hf: 'huggingface', 'hugging-face': 'huggingface', 'lm-studio': 'lmstudio', lm_studio: 'lmstudio', 'together-ai': 'together', togetherai: 'together', openai_compatible: 'custom', 'openai-compatible': 'custom' });

/** A requested provider name -> preset id, or null when it is not one of ours. */
function resolvePresetId(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim().toLowerCase();
  if (!n) return null;
  if (Object.prototype.hasOwnProperty.call(PRESETS, n)) return n;
  return ALIASES[n] || null;
}
const presetOf = (id) => PRESETS[resolvePresetId(id)] || null;
const toolCapFor = (id) => (presetOf(id) && !presetOf(id).hosted ? SELF_HOSTED_TOOL_CAP : COMPAT_TOOL_CAP);

function egressError(message) {
  const err = new Error(message);
  err.code = 'blocked_egress';
  err.statusCode = 400;
  return err;
}

/**
 * Parse an operator-entered base URL for a URL preset. Strips a pasted /chat/completions or
 * /models suffix and trailing slashes; a bare origin gets /v1 (where LM Studio and vLLM serve).
 * Custom (hosted) requires https. -> { ok:true, baseUrl, origin, host } | { ok:false, error }
 */
function parseCompatBase(raw, presetId) {
  const p = presetOf(presetId);
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: false, error: 'missing_base_url' };
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: 'invalid_base_url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'unsupported_scheme' };
  if (p && p.hosted && u.protocol !== 'https:') return { ok: false, error: 'https_required' };
  if (u.username || u.password) return { ok: false, error: 'credentials_in_url' };
  let path = u.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(chat\/completions|models)$/i, '').replace(/\/+$/, '');
  if (!path) path = '/v1';
  return { ok: true, baseUrl: `${u.origin}${path}`, origin: u.origin, host: u.host };
}

const compatChatUrl = (baseUrl) => `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
const compatModelsUrl = (baseUrl) => `${String(baseUrl).replace(/\/+$/, '')}/models`;

/**
 * Decide whether `baseUrl` may be called for this preset. Throws blocked_egress (statusCode 400).
 * @returns {Promise<{ private: boolean, ips: string[] }>}
 */
async function assertCompatEgress(baseUrl, presetId, { allowPrivateOrigin = null, resolver = dnsPromises, classify = classifyIp, isLoopback = isLoopbackIp } = {}) {
  const p = presetOf(presetId);
  if (!p) throw egressError('unknown_preset');
  let u;
  try { u = new URL(String(baseUrl)); } catch { throw egressError('invalid_base_url'); }
  if (p.hosted && u.protocol !== 'https:') throw egressError(`https_required: ${p.label} is reached over https only`);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw egressError('unsupported_scheme');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let ips;
  if (net.isIP(host)) ips = [host];
  else {
    try { ips = (await resolver.lookup(host, { all: true })).map((r) => r.address); }
    catch { throw egressError(`dns_resolution_failed: ${host}`); }
  }
  if (!ips.length) throw egressError(`no_dns_records: ${host}`);
  const classes = ips.map((ip) => classify(ip));
  if (p.hosted) {
    if (classes.some((c) => c !== 'public') || ips.some((ip) => isLoopback(ip))) {
      throw egressError(`blocked_host: ${host} is not a public address; ${p.label} reaches public https endpoints only (a server on your own network: use lmstudio or vllm)`);
    }
    return { private: false, ips };
  }
  if (classes.includes('hard')) throw egressError(`blocked_host: ${host} resolves to a link-local or reserved address`);
  if (ips.some((ip) => isLoopback(ip))) {
    throw egressError(`blocked_host: ${host} is a loopback address; the server cannot reach a model server on "localhost". Use the machine's LAN address`);
  }
  if (classes.includes('private')) {
    const allowed = normaliseOrigin(allowPrivateOrigin);
    if (allowed && allowed === u.origin) return { private: true, ips };
    throw egressError(`blocked_host: ${host} is a private address and ${u.origin} is not allow-listed for this org's ${p.label} connection`);
  }
  return { private: false, ips };
}

/** Request headers for a preset call. The key goes in Authorization only. */
function buildHeaders(preset, apiKey) {
  const p = typeof preset === 'string' ? presetOf(preset) : preset;
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  if (p && typeof p.headers === 'function') Object.assign(h, p.headers());
  return h;
}

function upstreamError(message, { status, code = 'provider_unreachable', statusCode = 502 } = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  if (status) err.upstreamStatus = status;
  return err;
}

/**
 * GET <base>/models. Never follows a redirect, never reflects the raw body.
 * -> [{ id, context_length, tools }] ; tools is true/false only when the provider says
 * (OpenRouter's supported_parameters), else null.
 */
async function listCompatModels(baseUrl, { headers = {}, fetchImpl = fetch, timeoutMs = 8000, signal, label = 'The provider' } = {}) {
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const url = compatModelsUrl(baseUrl);
  const h = { ...headers, Accept: 'application/json' };
  delete h['Content-Type'];
  let resp;
  try {
    resp = await fetchImpl(url, { method: 'GET', redirect: 'manual', headers: h, signal: sig });
  } catch (e) {
    const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `no answer within ${timeoutMs} ms` : ((e && e.cause && e.cause.code) || (e && e.message) || 'connection failed');
    throw upstreamError(`${label} did not answer at ${new URL(url).host}: ${why}`);
  }
  if (resp.status >= 300 && resp.status < 400) throw upstreamError(`${label} answered with a redirect (HTTP ${resp.status}); redirects are not followed`, { status: resp.status });
  if (resp.status === 401 || resp.status === 403) throw upstreamError(`${label} needs a valid key to list models (HTTP ${resp.status})`, { status: resp.status, code: 'auth_required', statusCode: 401 });
  if (!resp.ok) throw upstreamError(`${label} answered HTTP ${resp.status} for /models`, { status: resp.status });
  let data;
  try { data = await resp.json(); } catch { throw upstreamError(`${label} /models did not return JSON (is this an OpenAI-compatible server?)`); }
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : null);
  if (!list) throw upstreamError(`${label} /models returned no model list (is this an OpenAI-compatible server?)`);
  const out = [];
  for (const m of list.slice(0, MAX_MODELS)) {
    const id = m && typeof m.id === 'string' ? m.id.slice(0, 160) : '';
    if (!id) continue;
    const ctx = Number(m.context_length ?? m.max_model_len);
    const sp = Array.isArray(m.supported_parameters) ? m.supported_parameters : null;
    out.push({ id, context_length: Number.isFinite(ctx) && ctx > 0 ? ctx : null, tools: sp ? sp.includes('tools') : null });
  }
  return out;
}

/**
 * The org's DEFAULT credential of the preset's vault type -> what a call needs.
 * deps.resolveCredentials(orgId, [type]) gives { key?, credentialId? } (the resolver knows the
 * usual secret fields; Hugging Face's api_token it does not, so fields are read by id, org-verified
 * and audited, exactly as B3 reads Ollama's base_url).
 */
async function resolveCompatConfig(orgId, presetId, { resolveCredentials, resolveCredentialById } = {}) {
  const p = presetOf(presetId);
  if (!p) return { ok: false, error: 'unknown_preset' };
  if (typeof resolveCredentials !== 'function' || typeof resolveCredentialById !== 'function') return { ok: false, error: 'vault_unavailable' };
  const r = await resolveCredentials(orgId, [p.vaultType]);
  if (!r) return { ok: false, error: 'vault_unavailable' };
  const entry = (r.providers && r.providers[p.vaultType]) || {};
  let fields = {};
  if (entry.credentialId) {
    const c = await resolveCredentialById(entry.credentialId, orgId);
    if (!c || !c.fields || typeof c.fields !== 'object') return { ok: false, error: 'vault_unavailable' };
    fields = c.fields;
  } else if (p.url || !entry.key) {
    return { ok: false, error: 'not_connected' };
  }
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const apiKey = str(entry.key) || (p.keyField ? str(fields[p.keyField]) : null);
  if (p.key === 'required' && !apiKey) return { ok: false, error: 'not_connected' };
  let base;
  if (p.url) {
    const parsed = parseCompatBase(fields.base_url, p.id);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    base = parsed;
  } else {
    const u = new URL(p.baseUrl);
    base = { baseUrl: p.baseUrl, origin: u.origin, host: u.host };
  }
  return {
    ok: true,
    preset: p.id,
    credentialId: entry.credentialId || null,
    baseUrl: base.baseUrl,
    origin: base.origin,
    host: base.host,
    apiKey: p.key === 'none' ? null : apiKey,
    defaultModel: str(fields.default_model) ? str(fields.default_model).slice(0, 160) : null,
    allowPrivateOrigin: p.hosted ? null : normaliseOrigin(fields.allow_private_origin),
    // QUOXON: per-model option overrides (lib/modelOptions.js), object or JSON string.
    modelOptions: fields.model_options || null,
  };
}

function configErrorText(p, error) {
  const how = p.url ? `/connect ${p.id} <url>` : `/connect ${p.id}`;
  if (error === 'not_connected') return `${p.label} is not connected for this org. Connect it with ${how}.`;
  if (error === 'vault_unavailable') return `Could not read the ${p.label} connection from the vault right now. Try again shortly.`;
  return `The stored ${p.label} connection is not usable (${error}). Reconnect with ${how}.`;
}

/**
 * Everything the stream route needs before turn.started, in one call. Never throws.
 * Model: requested > credential default > (self-hosted only) first served. A hosted preset
 * with no model is an honest error: catalogues of hundreds of models are not guessed from.
 * -> { ok:true, preset, label, hosted, consentId, chatUrl, headers, extraBody, host, model, modelSource }
 *  | { ok:false, error, message }
 */
async function prepareCompatTurn({ orgId, preset, requestedModel }, deps = {}) {
  const p = presetOf(preset);
  if (!p) return { ok: false, error: 'unknown_preset', message: `No OpenAI-compatible preset called "${preset}".` };
  let cfg;
  try { cfg = await resolveCompatConfig(orgId, p.id, deps); } catch { cfg = { ok: false, error: 'vault_unavailable' }; }
  if (!cfg.ok) return { ok: false, error: cfg.error, message: configErrorText(p, cfg.error) };
  try {
    await assertCompatEgress(cfg.baseUrl, p.id, { allowPrivateOrigin: cfg.allowPrivateOrigin, ...(deps.egress || {}) });
  } catch (e) {
    return { ok: false, error: 'blocked_egress', message: `${p.label} at ${cfg.host} is not allowed: ${e.message}` };
  }
  const headers = buildHeaders(p, cfg.apiKey);
  const asked = typeof requestedModel === 'string' ? requestedModel.trim().slice(0, 160) : '';
  let model = asked || cfg.defaultModel;
  let modelSource = asked ? 'requested' : (cfg.defaultModel ? 'credential_default' : null);
  if (!model) {
    if (p.hosted) return { ok: false, error: 'no_model', message: `Pick a ${p.label} model first: /model ${p.id} <model> (/model ${p.id} lists them).` };
    let models;
    try { models = await listCompatModels(cfg.baseUrl, { headers, fetchImpl: deps.fetchImpl || fetch, label: p.label }); }
    catch (e) { return { ok: false, error: e.code || 'provider_unreachable', message: e.message }; }
    if (!models.length) return { ok: false, error: 'no_models', message: `${p.label} at ${cfg.host} serves no models. Load one there, then try again.` };
    model = models[0].id;
    modelSource = 'first_served';
  }
  // QUOXON: per-model request options. Self-hosted presets only (lmstudio, vllm); a hosted
  // preset gets none (requestExtrasFor maps nothing for it). Preset extras are never overridden.
  const mo = require('./modelOptions.js');
  const modelTurn = mo.modelTurnOptions(p.id, model, p.hosted ? null : cfg.modelOptions);
  return {
    ok: true, preset: p.id, label: p.label, hosted: p.hosted, consentId: p.consentId,
    chatUrl: compatChatUrl(cfg.baseUrl), headers, extraBody: mo.mergeExtraBody(p.extraBody, modelTurn.body) || p.extraBody, host: cfg.host, model, modelSource,
    modelTurn,
  };
}

/**
 * The plan for a preset. An explicit request for a preset (provider "openrouter", "groq", ...)
 * keeps the policy's say: when the policy blocked the user's override, the policy plan stands.
 * A policy plan that itself names a preset provider (a groq or together lane) runs on this path
 * with the policy's model. The model of an explicit request is only what was asked (the shared
 * catalogue's per-vendor defaults are stale guesses, so they are not used).
 */
function applyCompatSelection(plan, { requestedProvider, requestedModel } = {}) {
  if (!plan) return plan;
  const reasons = Array.isArray(plan.reasons) ? plan.reasons : [];
  const asked = resolvePresetId(requestedProvider);
  if (asked && !(plan.coercions && plan.coercions.userOverrideBlocked)) {
    return {
      ...plan,
      provider: PROVIDER_ID,
      preset: asked,
      model: typeof requestedModel === 'string' && requestedModel.trim() ? requestedModel.trim() : null,
      source: 'user_selection',
      reasons: [...reasons.filter((r) => !/^Unknown provider /.test(String(r))), `Explicit ${asked} selection (OpenAI-compatible).`],
    };
  }
  const lane = resolvePresetId(plan.provider);
  if (lane && plan.provider !== PROVIDER_ID) {
    return { ...plan, provider: PROVIDER_ID, preset: lane, reasons: asked ? [...reasons, `Policy blocked the explicit ${asked} selection; the policy plan stands.`] : reasons };
  }
  if (asked) return { ...plan, reasons: [...reasons, `Policy blocked the explicit ${asked} selection; the policy plan stands.`] };
  return plan;
}

/**
 * A model refusing tools, as each vendor says it: the B1 loop's tool_calling_unsupported
 * (a round-0 400 naming tools), OpenRouter's 404 "No endpoints found that support tool use",
 * Groq/vLLM style "does not support tool(s|calling)".
 */
function isToolsUnsupportedError(err) {
  if (!err) return false;
  if (err.code === 'tool_calling_unsupported') return true;
  const body = String(err.body || err.message || '');
  if (err.status === 404 && /support tool use/i.test(body)) return true;
  return (err.status === 400 || err.status === 422) && /(does not|doesn't|not) support(ed)? (tool|function)/i.test(body);
}

/** Run with tools; if the model refuses them, say so once (onNote) and retry ONCE without. */
async function runWithToolsFallback(runWith, tools, { onNote, model, preset } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  try {
    return await runWith(list);
  } catch (err) {
    if (!list.length || !isToolsUnsupportedError(err)) throw err;
    if (typeof onNote === 'function') {
      const p = presetOf(preset);
      const how = p ? ` Pick a tool-capable model with /model ${p.id} <model>.` : '';
      try { onNote(`${model || 'This model'} does not support tools, so this answer runs without them.${how}`); } catch { /* a note must never break the turn */ }
    }
    const res = await runWith([]);
    return { ...res, toolsFallback: true };
  }
}

/**
 * turn.finished.usage for a preset. Tokens are the provider's own. Cost: OpenRouter's reported
 * per-call cost (summed over rounds), cost_source "openrouter"; self-hosted 0; anyone else null.
 */
function compatTurnUsage(presetId) {
  const p = presetOf(presetId);
  return function normalize(u) {
    const o = u && typeof u === 'object' ? u : {};
    const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    const out = { input_tokens: num(o.prompt_tokens), output_tokens: num(o.completion_tokens), cost_usd: null, cost_source: null };
    if (p && !p.hosted) return { ...out, cost_usd: 0, cost_source: 'self_hosted' };
    if (p && p.costSource === 'openrouter' && num(o.cost) != null) return { ...out, cost_usd: Math.round(num(o.cost) * 1e9) / 1e9, cost_source: 'openrouter' };
    return out;
  };
}

/** fetchFn for the governed loop: never follows a redirect (a 3xx fails the call). */
function noRedirectFetch(fetchFn) {
  return (url, options, timeoutMs) => fetchFn(url, { ...(options || {}), redirect: 'manual' }, timeoutMs);
}

/**
 * Booleans for GET /api/v1/capabilities: does the org have a default credential (or a resolved
 * key) for each preset's vault type? Presence only, the same standard as OpenAI's key check;
 * the key value never leaves this function. Vault unreadable -> throws (the evaluator then says
 * "could not read", never "not connected").
 */
async function compatProviderAvailability(orgId, { resolveCredentials } = {}) {
  const ids = Object.keys(PRESETS);
  const r = typeof resolveCredentials === 'function' ? await resolveCredentials(orgId, ids.map((id) => PRESETS[id].vaultType)) : null;
  if (!r || !r.providers) throw new Error('vault unavailable');
  const out = {};
  for (const id of ids) {
    const e = r.providers[PRESETS[id].vaultType] || {};
    out[id] = Boolean(e.credentialId || (PRESETS[id].key !== 'none' && !PRESETS[id].url && e.key));
  }
  return out;
}

const publicModels = (models) => models.map((m) => ({ id: m.id, context_length: m.context_length, tools: m.tools }));

// ---- routes ---------------------------------------------------------------------------
/**
 * POST /api/v1/providers/compat/:preset/probe { base_url } (human org admin; URL presets only):
 * parse, egress, GET <base>/models WITHOUT a key. Nothing is stored and no key is accepted here
 * (a keyed endpoint answers needs_key; the key then goes through the secure card's server-side
 * test and the governed vault write). For a self-hosted preset the admin's typed origin is the
 * private allowance for this one call; loopback and link-local stay blocked.
 */
function createProbeHandler({ requireHumanAdmin, fetchImpl, egress } = {}) {
  return async function compatProbe(req, res) {
    const p = presetOf(req.params && req.params.preset);
    if (!p) return res.status(400).json({ ok: false, error: 'unknown_preset' });
    if (!p.url) return res.status(400).json({ ok: false, error: 'not_url_preset', message: `${p.label} has a fixed address; connect it with /connect ${p.id}.` });
    if (!requireHumanAdmin(req, res, `Connecting ${p.label} needs an org admin`)) return;
    const parsed = parseCompatBase(req.body && req.body.base_url, p.id);
    if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
    let eg;
    try { eg = await assertCompatEgress(parsed.baseUrl, p.id, { allowPrivateOrigin: p.hosted ? null : parsed.origin, ...(egress || {}) }); }
    catch (e) { return res.status(400).json({ ok: false, error: 'blocked_egress', message: e.message }); }
    const out = { ok: true, preset: p.id, base_url: parsed.baseUrl, origin: parsed.origin, host: parsed.host, private: eg.private };
    try {
      const models = await listCompatModels(parsed.baseUrl, { headers: {}, fetchImpl: fetchImpl || fetch, label: p.label });
      return res.json({ ...out, needs_key: false, models: publicModels(models) });
    } catch (e) {
      if (e.code === 'auth_required') return res.json({ ...out, needs_key: true, models: [] });
      return res.status(502).json({ ok: false, error: 'provider_unreachable', message: e.message });
    }
  };
}

/** GET /api/v1/providers/compat/:preset/models (any org member): the saved connection's models. */
function createModelsHandler({ resolveOrgId, deps = {} } = {}) {
  return async function compatModels(req, res) {
    const p = presetOf(req.params && req.params.preset);
    if (!p) return res.status(400).json({ ok: false, error: 'unknown_preset' });
    const orgId = resolveOrgId(req);
    let cfg;
    try { cfg = await resolveCompatConfig(orgId, p.id, deps); } catch { cfg = { ok: false, error: 'vault_unavailable' }; }
    if (!cfg.ok) {
      const code = cfg.error === 'not_connected' ? 404 : (cfg.error === 'vault_unavailable' ? 503 : 400);
      return res.status(code).json({ ok: false, error: cfg.error, message: configErrorText(p, cfg.error) });
    }
    try { await assertCompatEgress(cfg.baseUrl, p.id, { allowPrivateOrigin: cfg.allowPrivateOrigin, ...(deps.egress || {}) }); }
    catch (e) { return res.status(400).json({ ok: false, error: 'blocked_egress', host: cfg.host, message: e.message }); }
    try {
      const models = await listCompatModels(cfg.baseUrl, { headers: buildHeaders(p, cfg.apiKey), fetchImpl: deps.fetchImpl || fetch, label: p.label });
      return res.json({ ok: true, preset: p.id, host: cfg.host, default_model: cfg.defaultModel, models: publicModels(models) });
    } catch (e) {
      return res.status(e.code === 'auth_required' ? 401 : 502).json({ ok: false, error: e.code || 'provider_unreachable', host: cfg.host, message: e.message });
    }
  };
}

module.exports = {
  PROVIDER_ID,
  PRESETS,
  COMPAT_TOOL_CAP,
  SELF_HOSTED_TOOL_CAP,
  resolvePresetId,
  toolCapFor,
  parseCompatBase,
  compatChatUrl,
  compatModelsUrl,
  assertCompatEgress,
  buildHeaders,
  listCompatModels,
  resolveCompatConfig,
  prepareCompatTurn,
  applyCompatSelection,
  isToolsUnsupportedError,
  runWithToolsFallback,
  compatTurnUsage,
  noRedirectFetch,
  compatProviderAvailability,
  createProbeHandler,
  createModelsHandler,
};
