'use strict';
/**
 * CLI-QUOX B3: Ollama as a first-class /chat/stream provider.
 *
 * Ollama serves an OpenAI-compatible API at <base>/v1/chat/completions (streaming,
 * tools for models that support them) and lists installed models at <base>/api/tags.
 * The chat turn reuses the B1 governed loop (executeOpenAICompatibleToolLoop) with
 * this base URL and no API key; this module owns everything Ollama-specific:
 *
 *   - config: the org's DEFAULT `ollama` QuoxVault credential,
 *     { base_url, default_model?, allow_private_origin? } (no secret field)
 *   - egress: who may be called, and from where
 *   - model listing and model choice
 *   - the plan override (an explicit, policy-permitted selection of `ollama`)
 *   - the "this model does not support tools" retry
 *
 * EGRESS POLICY (read before changing). Same trade-off, same rule, as the QuoxChat
 * self-hosted provider (lib/quoxchatCompatLlm.js, which this reuses):
 *   - Public addresses pass.
 *   - Link-local (cloud metadata 169.254/16, fe80::), unspecified, multicast and
 *     reserved ranges are ALWAYS blocked.
 *   - Loopback (127/8, ::1) is ALWAYS blocked here. The collector runs in a
 *     container, so "localhost" is the collector itself, never the operator's
 *     Ollama; auth's LAN-target rule blocks loopback unconditionally for the same
 *     reason. Use the machine's LAN address.
 *   - Private ranges (RFC1918, CGNAT, fc00::/7) pass ONLY when that exact origin
 *     (scheme + host + port) was written as `allow_private_origin` into the org's
 *     vault credential, by a caller holding secrets.write, through the audited vault
 *     route. The pre-save probe route requires a HUMAN org admin and treats the
 *     admin's own typed URL as the allowance for that one call.
 *   - Redirects are never followed (redirect: 'manual'; a 3xx is a failure).
 * Residual (documented, same as the other egress guards): DNS rebinding between
 * resolve and connect is not pinned. An allow-listed origin is a standing trust
 * grant to that one host.
 */

const dnsPromises = require('node:dns/promises');
const net = require('node:net');
const { classifyIp, normaliseOrigin } = require('./quoxchatCompatLlm.js');

const PROVIDER_ID = 'ollama';
const LABEL = 'Ollama';
// Local models carry small context windows; a large tool catalogue would push the
// conversation out of the window. Smart retrieval picks the most relevant ones.
const OLLAMA_TOOL_CAP = 24;
const MAX_MODELS = 200;

function egressError(message) {
  const err = new Error(message);
  err.code = 'blocked_egress';
  err.statusCode = 400;
  return err;
}

function isLoopbackIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return ip.split('.')[0] === '127';
  if (fam === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isLoopbackIp(m[1]);
    const h = lower.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
    if (h) return (parseInt(h[1], 16) >> 8) === 127;
  }
  return false;
}

/**
 * Parse an operator-entered Ollama URL. Accepts http(s)://host[:port][/path], drops a
 * trailing /v1 or /api (people paste either), rejects credentials in the URL.
 * -> { ok:true, baseUrl, origin, host } | { ok:false, error }
 */
function parseOllamaBase(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: false, error: 'missing_base_url' };
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: 'invalid_base_url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'unsupported_scheme' };
  if (u.username || u.password) return { ok: false, error: 'credentials_in_url' };
  let p = u.pathname.replace(/\/+$/, '');
  p = p.replace(/\/(v1|api)$/i, '');
  const baseUrl = `${u.origin}${p}`;
  return { ok: true, baseUrl, origin: u.origin, host: u.host };
}

/**
 * Decide whether `baseUrl` may be called. Throws blocked_egress (statusCode 400).
 * @returns {Promise<{ private: boolean, ips: string[] }>}
 */
async function assertOllamaEgress(baseUrl, { allowPrivateOrigin = null, resolver = dnsPromises, classify = classifyIp, isLoopback = isLoopbackIp } = {}) {
  const parsed = parseOllamaBase(baseUrl);
  if (!parsed.ok) throw egressError(parsed.error);
  const host = new URL(parsed.baseUrl).hostname.replace(/^\[|\]$/g, '');
  let ips;
  if (net.isIP(host)) ips = [host];
  else {
    try { ips = (await resolver.lookup(host, { all: true })).map((r) => r.address); }
    catch { throw egressError(`dns_resolution_failed: ${host}`); }
  }
  if (!ips.length) throw egressError(`no_dns_records: ${host}`);
  const classes = ips.map((ip) => classify(ip));
  if (classes.includes('hard')) throw egressError(`blocked_host: ${host} resolves to a link-local or reserved address`);
  if (ips.some((ip) => isLoopback(ip))) {
    throw egressError(`blocked_host: ${host} is a loopback address; the server cannot reach an Ollama on "localhost". Use the machine's LAN address, for example http://<lan-ip>:11434`);
  }
  if (classes.includes('private')) {
    const allowed = normaliseOrigin(allowPrivateOrigin);
    if (allowed && allowed === parsed.origin) return { private: true, ips };
    throw egressError(`blocked_host: ${host} is a private address and ${parsed.origin} is not allow-listed for this org's Ollama connection`);
  }
  return { private: false, ips };
}

const ollamaChatUrl = (baseUrl) => `${String(baseUrl).replace(/\/+$/, '')}/v1/chat/completions`;
const ollamaTagsUrl = (baseUrl) => `${String(baseUrl).replace(/\/+$/, '')}/api/tags`;

function upstreamError(message, status) {
  const err = new Error(message);
  err.code = 'ollama_unreachable';
  err.statusCode = 502;
  if (status) err.upstreamStatus = status;
  return err;
}

/**
 * GET <base>/api/tags. Never follows a redirect, never reflects the raw body.
 * -> [{ name, size, family, parameter_size }]
 */
async function listOllamaModels(baseUrl, { fetchImpl = fetch, timeoutMs = 5000, signal } = {}) {
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let resp;
  try {
    resp = await fetchImpl(ollamaTagsUrl(baseUrl), { method: 'GET', redirect: 'manual', headers: { Accept: 'application/json' }, signal: sig });
  } catch (e) {
    const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `no answer within ${timeoutMs} ms` : ((e && e.cause && e.cause.code) || (e && e.message) || 'connection failed');
    throw upstreamError(`Ollama did not answer at ${new URL(ollamaTagsUrl(baseUrl)).host}: ${why}`);
  }
  if (resp.status >= 300 && resp.status < 400) throw upstreamError(`Ollama answered with a redirect (HTTP ${resp.status}); redirects are not followed`, resp.status);
  if (!resp.ok) throw upstreamError(`Ollama answered HTTP ${resp.status} for /api/tags`, resp.status);
  let data;
  try { data = await resp.json(); } catch { throw upstreamError('Ollama /api/tags did not return JSON (is this an Ollama server?)'); }
  if (!data || !Array.isArray(data.models)) throw upstreamError('Ollama /api/tags returned no model list (is this an Ollama server?)');
  const out = [];
  for (const m of data.models.slice(0, MAX_MODELS)) {
    const name = m && typeof (m.name || m.model) === 'string' ? String(m.name || m.model).slice(0, 120) : '';
    if (!name) continue;
    const d = (m && m.details) || {};
    out.push({
      name,
      size: Number.isFinite(Number(m.size)) ? Number(m.size) : null,
      family: typeof d.family === 'string' ? d.family.slice(0, 40) : null,
      parameter_size: typeof d.parameter_size === 'string' ? d.parameter_size.slice(0, 20) : null,
    });
  }
  return out;
}

/** Model choice: requested > credential default > first installed. -> { model, source } | { model:null } */
function pickOllamaModel({ requested, defaultModel, models } = {}) {
  const r = typeof requested === 'string' ? requested.trim() : '';
  if (r) return { model: r.slice(0, 120), source: 'requested' };
  const d = typeof defaultModel === 'string' ? defaultModel.trim() : '';
  if (d) return { model: d.slice(0, 120), source: 'credential_default' };
  const first = Array.isArray(models) && models[0] && models[0].name;
  return first ? { model: first, source: 'first_installed' } : { model: null, source: null };
}

/**
 * The org's default `ollama` vault credential -> its non-secret fields.
 * deps.resolveCredentials(orgId, ['ollama']) gives the default credential's id (the
 * credential has no secret field, so `key` is null and only credentialId comes back);
 * deps.resolveCredentialById(id, orgId) gives the fields (org-verified, audited).
 */
async function resolveOllamaConfig(orgId, { resolveCredentials, resolveCredentialById } = {}) {
  if (typeof resolveCredentials !== 'function' || typeof resolveCredentialById !== 'function') return { ok: false, error: 'vault_unavailable' };
  const r = await resolveCredentials(orgId, [PROVIDER_ID]);
  if (!r) return { ok: false, error: 'vault_unavailable' };
  const id = r.providers && r.providers[PROVIDER_ID] && r.providers[PROVIDER_ID].credentialId;
  if (!id) return { ok: false, error: 'not_connected' };
  const c = await resolveCredentialById(id, orgId);
  const fields = c && c.fields && typeof c.fields === 'object' ? c.fields : null;
  if (!fields) return { ok: false, error: 'vault_unavailable' };
  const parsed = parseOllamaBase(fields.base_url);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return {
    ok: true,
    credentialId: id,
    baseUrl: parsed.baseUrl,
    origin: parsed.origin,
    host: parsed.host,
    defaultModel: typeof fields.default_model === 'string' && fields.default_model.trim() ? fields.default_model.trim().slice(0, 120) : null,
    allowPrivateOrigin: normaliseOrigin(fields.allow_private_origin),
    // QUOXON: per-model option overrides (lib/modelOptions.js), object or JSON string.
    modelOptions: fields.model_options || null,
  };
}

const NOT_CONNECTED_TEXT = 'Ollama is not connected for this org. Connect it with /connect ollama http://<host>:11434 (or quox vault create ollama).';

function configErrorText(error) {
  if (error === 'not_connected') return NOT_CONNECTED_TEXT;
  if (error === 'vault_unavailable') return 'Could not read the Ollama connection from the vault right now. Try again shortly.';
  return `The stored Ollama URL is not usable (${error}). Reconnect with /connect ollama http://<host>:11434.`;
}

/**
 * Everything the stream route needs before turn.started, in one call. Never throws.
 * -> { ok:true, baseUrl, chatUrl, host, model, modelSource } | { ok:false, error, message }
 */
async function prepareOllamaTurn({ orgId, requestedModel }, deps = {}) {
  let cfg;
  try { cfg = await resolveOllamaConfig(orgId, deps); } catch { cfg = { ok: false, error: 'vault_unavailable' }; }
  if (!cfg.ok) return { ok: false, error: cfg.error, message: configErrorText(cfg.error) };
  try {
    await assertOllamaEgress(cfg.baseUrl, { allowPrivateOrigin: cfg.allowPrivateOrigin, ...(deps.egress || {}) });
  } catch (e) {
    return { ok: false, error: 'blocked_egress', message: `Ollama at ${cfg.host} is not allowed: ${e.message}` };
  }
  let pick = pickOllamaModel({ requested: requestedModel, defaultModel: cfg.defaultModel });
  if (!pick.model) {
    let models;
    try { models = await listOllamaModels(cfg.baseUrl, { fetchImpl: deps.fetchImpl || fetch }); }
    catch (e) { return { ok: false, error: 'ollama_unreachable', message: e.message }; }
    pick = pickOllamaModel({ models });
    if (!pick.model) return { ok: false, error: 'no_models', message: `Ollama at ${cfg.host} has no models installed. On that machine run: ollama pull qwen2.5` };
  }
  // QUOXON: per-model request options (thinking, keep_alive, ...) for the model that will run.
  const modelTurn = require('./modelOptions.js').modelTurnOptions(PROVIDER_ID, pick.model, cfg.modelOptions);
  return { ok: true, baseUrl: cfg.baseUrl, chatUrl: ollamaChatUrl(cfg.baseUrl), host: cfg.host, model: pick.model, modelSource: pick.source, modelTurn };
}

/**
 * The plan for an explicit `provider: "ollama"` request. The shared resolver does not
 * know `ollama` (it is not in MODEL_CATALOG, whose models are dynamic per machine) and
 * would silently swap it for the system default; this keeps the policy's say: when the
 * policy blocked the user's override, the policy plan stands (turn.started then shows
 * what ran and the client says so). Otherwise the plan becomes ollama.
 */
function applyOllamaSelection(plan, { requestedProvider, requestedModel } = {}) {
  if (requestedProvider !== PROVIDER_ID || !plan) return plan;
  const reasons = Array.isArray(plan.reasons) ? plan.reasons : [];
  if (plan.coercions && plan.coercions.userOverrideBlocked) {
    return { ...plan, reasons: [...reasons, 'Policy blocked the explicit ollama selection; the policy plan stands.'] };
  }
  return {
    ...plan,
    provider: PROVIDER_ID,
    model: typeof requestedModel === 'string' && requestedModel.trim() ? requestedModel.trim() : null,
    source: 'user_selection',
    reasons: [...reasons.filter((r) => !/^Unknown provider ollama/.test(String(r))), 'Explicit ollama selection (self-hosted, OpenAI-compatible).'],
  };
}

/** Ollama's "<model> does not support tools" (HTTP 400), as the B1 loop surfaces it. */
function isToolsUnsupportedError(err) {
  if (!err) return false;
  if (err.code === 'tool_calling_unsupported') return true;
  return err.status === 400 && /does not support tools/i.test(String(err.body || err.message || ''));
}

/**
 * Run the loop with tools; if the model refuses tools, say so once (onNote) and retry
 * ONCE without them. runWith(tools) must run a complete loop with that tool list.
 */
async function runWithToolsFallback(runWith, tools, { onNote, model } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  try {
    return await runWith(list);
  } catch (err) {
    if (!list.length || !isToolsUnsupportedError(err)) throw err;
    if (typeof onNote === 'function') {
      try { onNote(`${model || 'This model'} does not support tools, so this answer runs without them. Pick a tool-capable model (for example qwen2.5 or llama3.1) with /model ollama <model>.`); } catch { /* a note must never break the turn */ }
    }
    const res = await runWith([]);
    return { ...res, toolsFallback: true };
  }
}

/** turn.finished.usage: provider token counts when reported; self-hosted, so no metered cost. */
function ollamaTurnUsage(u) {
  const o = u && typeof u === 'object' ? u : {};
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return { input_tokens: num(o.prompt_tokens), output_tokens: num(o.completion_tokens), cost_usd: 0, cost_source: 'self_hosted' };
}

// Z2H-3B: a local CPU model prefills slowly (the first turn also loads the model), so the wait for the first
// byte and the idle gap between chunks are 300 s by default, not the 120 s the hosted loops use.
const OLLAMA_TURN_TIMEOUT_MS = 300000;
function ollamaTurnTimeoutMs(env = process.env) {
  const n = Number(env && env.QUOX_OLLAMA_TURN_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : OLLAMA_TURN_TIMEOUT_MS;
}

/** True for the errors a timed-out call raises (fetch abort, or the stream idle guard). */
function isOllamaTimeoutError(err) {
  if (!err) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'provider_stream_idle'
    || /operation was aborted|stream idle/i.test(String(err.message || ''));
}

/** The plain-language timeout message; every line is under 100 columns (the CLI truncates longer ones). */
function ollamaTimeoutMessage({ model, host, timeoutMs }) {
  const secs = Math.round((timeoutMs || OLLAMA_TURN_TIMEOUT_MS) / 1000);
  return [
    `Your Ollama (${model || 'model'} at ${host || 'this host'}) did not answer within ${secs} s.`,
    'Local models on a CPU can be slow, especially the first turn while the model loads.',
    'Try a smaller model, a machine with a GPU or AVX2, or raise QUOX_OLLAMA_TURN_TIMEOUT_MS.',
  ].join('\n');
}

/** fetchFn for the governed loop: never follows a redirect (a 3xx fails the call). */
function noRedirectFetch(fetchFn) {
  return (url, options, timeoutMs) => fetchFn(url, { ...(options || {}), redirect: 'manual' }, timeoutMs);
}

// ---- routes ---------------------------------------------------------------------------
/**
 * POST /api/v1/providers/ollama/probe { base_url } (human org admin): parse, egress,
 * GET /api/tags. Nothing is stored. The admin's typed origin is the private allowance
 * for this one call; loopback and link-local stay blocked.
 */
function createProbeHandler({ requireHumanAdmin, fetchImpl, egress } = {}) {
  return async function ollamaProbe(req, res) {
    if (!requireHumanAdmin(req, res, 'Connecting Ollama needs an org admin')) return;
    const parsed = parseOllamaBase(req.body && req.body.base_url);
    if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
    let eg;
    try { eg = await assertOllamaEgress(parsed.baseUrl, { allowPrivateOrigin: parsed.origin, ...(egress || {}) }); }
    catch (e) { return res.status(400).json({ ok: false, error: 'blocked_egress', message: e.message }); }
    try {
      const models = await listOllamaModels(parsed.baseUrl, { fetchImpl: fetchImpl || fetch });
      return res.json({ ok: true, base_url: parsed.baseUrl, origin: parsed.origin, host: parsed.host, private: eg.private, models });
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'ollama_unreachable', message: e.message });
    }
  };
}

/** GET /api/v1/providers/ollama/models (any org member): the saved connection's models. */
function createModelsHandler({ resolveOrgId, deps = {} } = {}) {
  return async function ollamaModels(req, res) {
    const orgId = resolveOrgId(req);
    let cfg;
    try { cfg = await resolveOllamaConfig(orgId, deps); } catch { cfg = { ok: false, error: 'vault_unavailable' }; }
    if (!cfg.ok) return res.status(cfg.error === 'not_connected' ? 404 : 503).json({ ok: false, error: cfg.error, message: configErrorText(cfg.error) });
    try { await assertOllamaEgress(cfg.baseUrl, { allowPrivateOrigin: cfg.allowPrivateOrigin, ...(deps.egress || {}) }); }
    catch (e) { return res.status(400).json({ ok: false, error: 'blocked_egress', host: cfg.host, message: e.message }); }
    try {
      const models = await listOllamaModels(cfg.baseUrl, { fetchImpl: deps.fetchImpl || fetch });
      return res.json({ ok: true, host: cfg.host, default_model: cfg.defaultModel, models });
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'ollama_unreachable', host: cfg.host, message: e.message });
    }
  };
}

/** Z2H-R4: a prepared Ollama turn as the source shape handleLocalInferenceChat takes (/chat/claude path). */
function localSourceFromOllamaTurn(turn) {
  return { id: `ollama ${turn.host}`, baseUrl: turn.baseUrl, backendType: 'ollama' };
}

module.exports = {
  PROVIDER_ID,
  localSourceFromOllamaTurn,
  LABEL,
  OLLAMA_TOOL_CAP,
  parseOllamaBase,
  assertOllamaEgress,
  isLoopbackIp,
  ollamaChatUrl,
  listOllamaModels,
  pickOllamaModel,
  resolveOllamaConfig,
  prepareOllamaTurn,
  applyOllamaSelection,
  isToolsUnsupportedError,
  runWithToolsFallback,
  ollamaTurnUsage,
  noRedirectFetch,
  OLLAMA_TURN_TIMEOUT_MS,
  ollamaTurnTimeoutMs,
  isOllamaTimeoutError,
  ollamaTimeoutMessage,
  createProbeHandler,
  createModelsHandler,
};
