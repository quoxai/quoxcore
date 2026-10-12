/**
 * BRAIN2-W12 D: direct small-model completion for the Qortex reranker.
 *
 * Replaces the loopback call to the agent endpoint /chat/complete (which loads
 * the agent prompt and pipeline and took 8 s median). Calls the OpenAI chat
 * completions API directly with the org's OpenAI key (same resolution as
 * embedText: org provider keys, then instance env). No key means a clear
 * 'rerank_provider_unavailable' error; there is NO silent fallback to the slow
 * agent path. Logs model, tokens and latency only, never content.
 */

const RERANK_TIMEOUT_MS = 5000;
const DEFAULT_RERANK_MODEL = 'gpt-4o-mini';

function providerUnavailable() {
  const e = new Error('rerank_provider_unavailable');
  e.code = 'rerank_provider_unavailable';
  return e;
}

/**
 * @param {object} deps
 * @param {(orgId:string|null) => Promise<object>} deps.getProviderKeys
 * @param {(orgId:string|null) => string|null} [deps.getModelSetting] per-org BRAIN_RERANK_MODEL
 * @param {Function} [deps.fetchImpl]
 */
function createOpenAIRerankComplete({ getProviderKeys, getModelSetting, fetchImpl = fetch, timeoutMs = RERANK_TIMEOUT_MS, log = console.log }) {
  return async function complete({ orgId, system, prompt, maxTokens }) {
    let keys = null;
    try { keys = await getProviderKeys(orgId || null); } catch { keys = null; }
    const apiKey = keys?.openai_api_key || process.env.OPENAI_API_KEY;
    if (!apiKey) throw providerUnavailable();

    let model = '';
    try { model = String((typeof getModelSetting === 'function' ? getModelSetting(orgId || null) : '') || '').trim(); } catch { model = ''; }
    // A non-OpenAI model name (for example an old Claude default) cannot be served here.
    if (!model || !/^(gpt|o\d|chatgpt)/i.test(model)) model = DEFAULT_RERANK_MODEL;

    const body = {
      model,
      temperature: 0,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    };
    if (/^gpt-5($|[-.])/.test(model)) { body.max_completion_tokens = maxTokens; delete body.temperature; } else { body.max_tokens = maxTokens; }

    const t0 = Date.now();
    const resp = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      log(`[rerank] model=${model} status=${resp.status} ms=${Date.now() - t0}`);
      throw new Error(`OpenAI HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const u = data?.usage || {};
    log(`[rerank] model=${model} prompt_tokens=${u.prompt_tokens ?? '?'} completion_tokens=${u.completion_tokens ?? '?'} ms=${Date.now() - t0}`);
    return { text: data?.choices?.[0]?.message?.content || '', model: data?.model || model };
  };
}

module.exports = { createOpenAIRerankComplete, DEFAULT_RERANK_MODEL, RERANK_TIMEOUT_MS };
