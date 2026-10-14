'use strict';
/**
 * QUOXON-MODEL: live model discovery for the hosted providers, so nobody maintains model lists.
 *
 *   openai    GET https://api.openai.com/v1/models      (filtered to chat families, newest first)
 *   anthropic GET https://api.anthropic.com/v1/models   (already newest first)
 *
 * Cached per (org, provider) for 1 hour; ?refresh=1 (what /model sends) bypasses the cache.
 * Failure is reported, never swallowed into an empty list: { ok:false, error, message }.
 * The Claude SUBSCRIPTION path has no key to list with, so it uses the Claude CLI's own family
 * aliases (SUBSCRIPTION_ALIASES), which the CLI resolves to the newest model itself.
 */

const TTL_MS = 60 * 60 * 1000;
const SUBSCRIPTION_ALIASES = Object.freeze(['fable', 'opus', 'sonnet', 'haiku']);
const _cache = new Map(); // `${org}|${provider}` -> { at, value }

const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-)/i;
const OPENAI_NOT_CHAT = /(embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|search|instruct|codex|davinci|babbage|sora|computer-use)/i;
const familyOf = (id) => {
  const m = /(fable|opus|sonnet|haiku)/i.exec(id);
  if (m) return m[1].toLowerCase();
  const g = /^(gpt-[\d.]+(?:-(?:mini|nano|pro))?|o\d+(?:-(?:mini|pro))?)/i.exec(id);
  return g ? g[1].toLowerCase() : null;
};

function normalise(provider, body) {
  const rows = Array.isArray(body && body.data) ? body.data : [];
  let out = rows.map((m) => ({
    id: String(m.id || ''),
    created: m.created != null ? Number(m.created) : (m.created_at ? Date.parse(m.created_at) / 1000 : 0),
    name: m.display_name || null,
  })).filter((m) => m.id);
  if (provider === 'openai') out = out.filter((m) => OPENAI_CHAT.test(m.id) && !OPENAI_NOT_CHAT.test(m.id));
  out.sort((a, b) => (b.created || 0) - (a.created || 0));
  return out.map((m) => ({ ...m, family: familyOf(m.id) }));
}

/** -> { ok:true, provider, models:[{id,created,name,family}], default_model, source, fetched_at } | { ok:false, error, message } */
async function discoverModels(provider, { orgId = null, apiKey = '', fetchImpl = fetch, refresh = false, now = Date.now } = {}) {
  if (provider !== 'openai' && provider !== 'anthropic') return { ok: false, error: 'unsupported_provider', message: `No live model list for ${provider}.` };
  const key = `${orgId || ''}|${provider}`;
  const hit = _cache.get(key);
  if (!refresh && hit && now() - hit.at < TTL_MS) return { ...hit.value, source: 'cache' };
  if (!apiKey) return { ok: false, error: 'not_connected', message: `${provider === 'openai' ? 'OpenAI' : 'Claude API'} is not connected, so its models cannot be listed.` };
  const url = provider === 'openai' ? 'https://api.openai.com/v1/models' : 'https://api.anthropic.com/v1/models?limit=100';
  const headers = provider === 'openai'
    ? { Authorization: `Bearer ${apiKey}` }
    : (apiKey.startsWith('sk-ant-oat01-') ? { Authorization: `Bearer ${apiKey}` } : { 'x-api-key': apiKey }) ;
  if (provider === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  try {
    const resp = await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      return { ok: false, error: resp.status === 401 || resp.status === 403 ? 'auth_required' : 'provider_error', status: resp.status, message: `${provider} /v1/models answered ${resp.status}.` };
    }
    const models = normalise(provider, await resp.json());
    if (!models.length) return { ok: false, error: 'no_models', message: `${provider} listed no usable chat models.` };
    const value = { ok: true, provider, models, default_model: models[0].id, fetched_at: new Date(now()).toISOString() };
    _cache.set(key, { at: now(), value });
    return { ...value, source: 'live' };
  } catch (e) {
    return { ok: false, error: 'provider_unreachable', message: `${provider} model list failed: ${e.message}` };
  }
}

/** GET /api/v1/providers/:provider/models (any org member). deps: resolveOrgId, getKey(orgId, provider). */
function createModelsHandler({ resolveOrgId, getKey, fetchImpl } = {}) {
  return async function providerModels(req, res) {
    const provider = req.params && req.params.provider;
    if (provider !== 'openai' && provider !== 'anthropic') return res.status(400).json({ ok: false, error: 'unsupported_provider' });
    const orgId = resolveOrgId(req);
    let apiKey = '';
    try { apiKey = (await getKey(orgId, provider)) || ''; } catch { apiKey = ''; }
    const r = await discoverModels(provider, { orgId, apiKey, fetchImpl: fetchImpl || fetch, refresh: req.query && /^(1|true)$/.test(String(req.query.refresh || '')) });
    const withAliases = r.ok && provider === 'anthropic' ? { ...r, subscription_aliases: SUBSCRIPTION_ALIASES } : r;
    if (!r.ok && provider === 'anthropic') return res.status(r.error === 'not_connected' ? 200 : 502).json({ ...r, subscription_aliases: SUBSCRIPTION_ALIASES });
    return res.status(r.ok ? 200 : (r.error === 'not_connected' ? 404 : 502)).json(withAliases);
  };
}

const ANTHROPIC_ID = /^claude-[a-z0-9.\-]+$/i;
const isAlias = (m) => SUBSCRIPTION_ALIASES.includes(String(m || '').toLowerCase());

/**
 * The shared policy resolver only knows a static catalogue and would reset a newer model to its default
 * (silently). An explicit anthropic/openai request that looks like a real id (or a Claude family alias)
 * keeps the user's say; the provider validates it on first use and the error is shown plainly.
 */
function applyDiscoveredSelection(plan, { requestedProvider, requestedModel } = {}) {
  if (!plan || typeof requestedModel !== 'string' || !requestedModel.trim()) return plan;
  const m = requestedModel.trim();
  if (plan.coercions && plan.coercions.userOverrideBlocked) return plan;
  if (plan.model === m) return plan;
  const prov = plan.provider;
  if (requestedProvider && requestedProvider !== prov) return plan;
  const ok = (prov === 'anthropic' && (ANTHROPIC_ID.test(m) || isAlias(m))) || (prov === 'openai' && OPENAI_CHAT.test(m) && !OPENAI_NOT_CHAT.test(m));
  if (!ok) return plan;
  return { ...plan, model: m, source: 'user_selection', reasons: [...(Array.isArray(plan.reasons) ? plan.reasons : []), `Explicit ${prov} model ${m} kept (models are discovered live, not catalogued).`] };
}

/** A Claude family alias -> the newest discovered id of that family (API path); anything else unchanged. */
async function resolveClaudeAlias(model, discoverOpts) {
  if (!isAlias(model)) return model;
  const r = await discoverModels('anthropic', discoverOpts);
  const hit = r.ok && r.models.find((x) => x.family === String(model).toLowerCase());
  return hit ? hit.id : model;
}

const _resetCache = () => _cache.clear();
module.exports = { discoverModels, applyDiscoveredSelection, resolveClaudeAlias, isAlias, createModelsHandler, normalise, SUBSCRIPTION_ALIASES, TTL_MS, _resetCache };
