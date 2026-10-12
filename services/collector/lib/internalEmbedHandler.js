/**
 * Qortex P4-WP1 — internal embedding-batch handler.
 * (docs/STREAM_QUOXBRAIN2_OVERNIGHT_BUILD.md Phase F, docs/STREAM_QUOXBRAIN_SECONDBRAIN_LENS.md §P4)
 *
 * Handles POST /internal/embed — a thin, service-key-only wrapper around
 * quoxchat's embedText() so quoxbrain (and any other internal caller) can
 * batch-embed a list of strings without duplicating the Gemini/OpenAI
 * provider logic. Route wiring (auth + mount) lives in server.js; this file
 * holds the testable handler logic, dependency-injected so tests never hit
 * a real embedding provider.
 *
 * Contract:
 *   POST body { texts: string[] }  (max EMBED_BATCH_CAP per call)
 *   200 { vectors: (number[]|null)[], model, dim }  — one entry per input
 *       text, aligned by index; null where embedText couldn't produce a
 *       vector for that text (missing key, provider error, etc).
 *   400 — texts missing/empty/non-array, texts.length > EMBED_BATCH_CAP,
 *       or any element isn't a string.
 *
 * Best-effort per text: a single embed failure never fails the batch and
 * never 500s — the failing slot is just `null`. Never logs text content
 * (only the error message, on failure).
 */

const configResolver = require('./configResolver.js');
const { OPENAI_EMBED_MODELS, resolveOpenAIEmbedModel, openAIEmbedStamp } = require('./brainEmbedModel.js');

const EMBED_BATCH_CAP = 64;
const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_DIM = 768;

/**
 * @param {object} deps
 * @param {(text: string, providerKeys: object, opts?: object) => Promise<{vector:number[]}|null>} deps.embedText
 * @param {(req: import('express').Request) => Promise<object>} [deps.getProviderKeys] — optional;
 *   defaults to {} when omitted. Receives the request so the caller can
 *   org-scope key resolution (e.g. via resolveRequestOrgId(req)) — org-scoped
 *   BYOK keys can never resolve without it.
 * @param {(req: import('express').Request) => string|null} [deps.getOrgId] — optional
 *   (VAULT-INTEG P17); when supplied, org-scopes the QUOXCHAT_EMBED_PROVIDER
 *   resolution embedText() performs (a stored per-org override otherwise
 *   never reaches this internal, service-key-only call path).
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<void>}
 */
function createEmbedHandler({ embedText, getProviderKeys, getOrgId }) {
  return async function handleInternalEmbed(req, res) {
    const { texts, model: requestedModel } = req.body || {};

    if (!Array.isArray(texts) || texts.length === 0) {
      return res.status(400).json({ error: 'texts (non-empty array) is required' });
    }
    if (texts.length > EMBED_BATCH_CAP) {
      return res.status(400).json({ error: `texts exceeds max batch of ${EMBED_BATCH_CAP}` });
    }
    if (!texts.every((t) => typeof t === 'string')) {
      return res.status(400).json({ error: 'texts must be an array of strings' });
    }

    // BRAIN2-W11: optional explicit OpenAI model (bare name or stamp) so
    // quoxbrain can embed a query in the PREVIOUS space during migration.
    if (requestedModel !== undefined && requestedModel !== null
      && !(typeof requestedModel === 'string' && OPENAI_EMBED_MODELS.includes(requestedModel.split('@')[0]))) {
      return res.status(400).json({ error: `model must be one of ${OPENAI_EMBED_MODELS.join(', ')}` });
    }

    const providerKeys = getProviderKeys
      ? await getProviderKeys(req).catch(() => ({}))
      : {};
    const orgId = typeof getOrgId === 'function' ? getOrgId(req) : null;

    const results = await Promise.all(texts.map(async (text) => {
      try {
        const result = await embedText(text, providerKeys, requestedModel ? { orgId, model: requestedModel } : { orgId });
        return result?.vector ? { vector: result.vector, model: result.model || null } : null;
      } catch (err) {
        // Best-effort: a single bad embed never fails the batch. Only the
        // error message is logged — never the source text.
        console.error('[internal/embed] single embed failed:', err?.message);
        return null;
      }
    }));

    // models[i] is the model that ACTUALLY produced vectors[i] (null on
    // failure or when the provider didn't say). The top-level model/dim
    // fields predate the 2026-08-25 embedding-space-split incident — model
    // was a hardcoded constant that mis-stamped 44k corpus rows while
    // embedText was really using OpenAI. Kept for legacy callers; new code
    // must read models[].
    res.json({
      vectors: results.map((r) => r?.vector || null),
      models: results.map((r) => r?.model || null),
      model: EMBED_MODEL,
      dim: EMBED_DIM,
    });
  };
}

/**
 * GET /internal/embed/provider — which embedding provider WOULD serve an
 * embed call right now, from key resolvability alone (no provider API call,
 * no spend). Mirrors embedText's precedence exactly: openai-first (default
 * QUOXCHAT_EMBED_PROVIDER) falling through to gemini. Powers the honest
 * `embeddings` state on quoxbrain's /brain/status (ready | indexing |
 * no_provider) — BRAIN2-SEMANTIC, replacing the silent-FTS-fallback UX.
 *
 * 200 { provider: 'openai'|'gemini'|null, model: string|null }
 */
function createEmbedProviderHandler({ getProviderKeys, getOrgId }) {
  return async function handleEmbedProvider(req, res) {
    const providerKeys = getProviderKeys
      ? await getProviderKeys(req).catch(() => ({}))
      : {};
    const orgId = typeof getOrgId === 'function' ? getOrgId(req) : null;

    // VAULT-INTEG P17: was a bare process.env read — now resolved via
    // configResolver, org-scoped when getOrgId is supplied, so this stays
    // genuinely honest about "which provider WOULD embed right now" for an
    // org with a stored override, not just the instance-wide default.
    const embedProvider = (orgId
      ? configResolver.getSetting(orgId, 'QUOXCHAT_EMBED_PROVIDER').value
      : configResolver.getInstanceSetting('QUOXCHAT_EMBED_PROVIDER').value) || 'openai';
    if (embedProvider === 'openai' && (providerKeys?.openai_api_key || process.env.OPENAI_API_KEY)) {
      return res.json({ provider: 'openai', model: openAIEmbedStamp(resolveOpenAIEmbedModel()) });
    }
    if (providerKeys?.gemini_api_key || process.env.GEMINI_API_KEY) {
      return res.json({ provider: 'gemini', model: EMBED_MODEL });
    }
    res.json({ provider: null, model: null });
  };
}

module.exports = { createEmbedHandler, createEmbedProviderHandler, EMBED_BATCH_CAP, EMBED_MODEL, EMBED_DIM };
