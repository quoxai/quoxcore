'use strict';
/**
 * BRAIN2-FABLE11: local embedding provider via the org's Ollama connection.
 *
 * Lets an org embed Brain2 / QuoxChat text with ZERO third-party egress. Everything
 * Ollama-specific (URL parsing, egress decision incl. loopback refusal and
 * allow_private_origin, credential resolution) is REUSED from lib/ollamaProvider.js;
 * this module only owns the embed request, the dimension guard and the space stamp.
 *
 * Embedding space: vectors from different models are different spaces. The stamp is
 * `ollama:<model>@768` (see lib/brainEmbedModel.js for the OpenAI stamps). Dimensions
 * are fixed at 768 (QDRANT_VECTOR_SIZE); a model returning any other length FAILS the
 * embed loudly (null + diag), a wrong-dim vector is never returned or stored.
 *
 * NO fallthrough: when an org chose ollama, a failure here is a failure. Sending the
 * text to OpenAI/Gemini instead would be exactly the egress the org opted out of.
 */

const configResolver = require('./configResolver.js');
const O = require('./ollamaProvider.js');

const EMBED_DIM = 768;
const STAMP_PREFIX = 'ollama:';
const DEFAULT_OLLAMA_EMBED_MODEL = 'nomic-embed-text';

let _vaultDeps = {};
/** Wired once at boot (server.js via quoxchat init): { resolveCredentials, resolveCredentialById }. */
function configureOllamaEmbed(deps) { _vaultDeps = { ..._vaultDeps, ...(deps || {}) }; }

function ollamaEmbedStamp(model, dims = EMBED_DIM) { return `${STAMP_PREFIX}${model}@${dims}`; }
function isOllamaStamp(s) { return typeof s === 'string' && s.startsWith(STAMP_PREFIX); }
/** 'ollama:nomic-embed-text:v1.5@768' -> 'nomic-embed-text:v1.5'; null when not an ollama stamp. */
function parseOllamaStamp(s) {
  if (!isOllamaStamp(s)) return null;
  const body = s.slice(STAMP_PREFIX.length).replace(/@\d+$/, '');
  return body || null;
}

/** requested (stamp or bare ollama model) > BRAIN_OLLAMA_EMBED_MODEL setting > default. */
function resolveOllamaEmbedModel(orgId, requested) {
  const fromStamp = parseOllamaStamp(requested);
  if (fromStamp) return fromStamp;
  let v = null;
  try {
    v = (orgId ? configResolver.getSetting(orgId, 'BRAIN_OLLAMA_EMBED_MODEL') : configResolver.getInstanceSetting('BRAIN_OLLAMA_EMBED_MODEL')).value;
  } catch { v = null; }
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : DEFAULT_OLLAMA_EMBED_MODEL;
}

async function resolveAndCheck(orgId, deps) {
  const vault = { resolveCredentials: deps.resolveCredentials || _vaultDeps.resolveCredentials, resolveCredentialById: deps.resolveCredentialById || _vaultDeps.resolveCredentialById };
  let cfg;
  try { cfg = await O.resolveOllamaConfig(orgId, vault); } catch { cfg = { ok: false, error: 'vault_unavailable' }; }
  if (!cfg.ok) return { ok: false, error: cfg.error };
  try {
    await O.assertOllamaEgress(cfg.baseUrl, { allowPrivateOrigin: cfg.allowPrivateOrigin, ...(deps.egress || {}) });
  } catch (e) {
    return { ok: false, error: 'blocked_egress', message: e.message, host: cfg.host };
  }
  return { ok: true, cfg };
}

/**
 * Which ollama embed WOULD serve right now, from connection + egress alone (no embed call).
 * -> { ok:true, model: stamp, host } | { ok:false, error }
 */
async function ollamaEmbedAvailability(orgId, { requestedModel, deps = {} } = {}) {
  const r = await resolveAndCheck(orgId, deps);
  if (!r.ok) return r;
  return { ok: true, model: ollamaEmbedStamp(resolveOllamaEmbedModel(orgId, requestedModel)), host: r.cfg.host };
}

/**
 * Embed one text via the org's Ollama. -> { vector, provider:'ollama', model: stamp } | null.
 * Never throws; failures set diag { provider, status, error } and log (no bodies of user text).
 */
async function embedWithOllama(text, { orgId = null, model = null, timeoutMs = 10000, diag = null, deps = {} } = {}) {
  const fail = (error, status = null, extra = '') => {
    if (diag) { diag.provider = 'ollama'; diag.status = status; diag.error = error; }
    console.warn(`[QuoxChat] embedText: Ollama embed failed (${error}${status ? ` HTTP ${status}` : ''})${extra ? `: ${extra}` : ''}. No fallback: this org chose local embeddings.`);
    return null;
  };
  const r = await resolveAndCheck(orgId, deps);
  if (!r.ok) return fail(r.error, null, r.message || '');
  const ollamaModel = resolveOllamaEmbedModel(orgId, model);
  const fetchImpl = deps.fetchImpl || fetch;
  let resp;
  try {
    resp = await fetchImpl(`${r.cfg.baseUrl}/api/embed`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: ollamaModel, input: text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fail('request_failed', null, `${err && err.name}: ${err && err.message}`);
  }
  if (!resp.ok) {
    const excerpt = await resp.text().catch(() => '');
    const hint = resp.status === 404 ? ` (is the model pulled? run: ollama pull ${ollamaModel})` : '';
    return fail('http_error', resp.status, `${String(excerpt).slice(0, 160)}${hint}`);
  }
  let data;
  try { data = await resp.json(); } catch { return fail('bad_json'); }
  const vector = data && Array.isArray(data.embeddings) ? data.embeddings[0] : null;
  if (!Array.isArray(vector) || vector.length === 0) return fail('no_embedding');
  if (vector.length !== EMBED_DIM) return fail('dim_mismatch', null, `${ollamaModel} returned ${vector.length} dims, need ${EMBED_DIM}`);
  return { vector, provider: 'ollama', model: ollamaEmbedStamp(ollamaModel) };
}

module.exports = {
  EMBED_DIM, STAMP_PREFIX, DEFAULT_OLLAMA_EMBED_MODEL,
  configureOllamaEmbed, ollamaEmbedStamp, isOllamaStamp, parseOllamaStamp,
  resolveOllamaEmbedModel, ollamaEmbedAvailability, embedWithOllama,
};
