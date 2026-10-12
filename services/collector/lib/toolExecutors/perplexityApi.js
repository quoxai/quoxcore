/**
 * Perplexity API Tool Executor
 *
 * Wraps the Perplexity Sonar API for structured web research tasks.
 * Uses fetch() to call the OpenAI-compatible chat completions endpoint.
 *
 * Domain: web search with citations, fact verification, academic research, current events.
 * NOT for general knowledge (that's SCHOLAR) or code review (that's GEMINI).
 *
 * API: POST https://api.perplexity.ai/chat/completions
 * Auth: Bearer token via PERPLEXITY_API_KEY env var
 */

const configResolver = require('../configResolver.js');

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';
// Kept for back-compat (no other consumer references this today) — a
// module-load snapshot, no longer what callPerplexityApi() actually uses
// for its default model.
const PERPLEXITY_DEFAULT_MODEL = process.env.PERPLEXITY_MODEL || 'sonar';
// Kept for back-compat (no other consumer references this today, but this
// module doesn't own the removal of an exported constant) — a module-load
// snapshot, no longer what callPerplexityApi() actually uses for its
// timeout.
const PERPLEXITY_TIMEOUT_MS = parseInt(process.env.PERPLEXITY_TIMEOUT || '60000', 10);
const PERPLEXITY_DEFAULT_TIMEOUT_MS = 60000; // matches platformCapabilities.js PERPLEXITY_TIMEOUT's registry default
const PERPLEXITY_MAX_QUERY_LENGTH = 32000; // 32K chars

// VAULT-INTEG P13 slice 2: was a bare process.env read frozen at module
// load (PERPLEXITY_TIMEOUT_MS above) — now resolved through
// configResolver.getInstanceSetting() (platformCapabilities.js
// PERPLEXITY_TIMEOUT), called fresh on every callPerplexityApi() call, so a
// stored/env override applies to the very next tool call, no restart
// needed.
function getPerplexityTimeoutMs() {
  const parsed = parseInt(configResolver.getInstanceSetting('PERPLEXITY_TIMEOUT').value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PERPLEXITY_DEFAULT_TIMEOUT_MS;
}

// VAULT-INTEG P17: was a bare process.env read frozen at module load
// (PERPLEXITY_DEFAULT_MODEL above) — now resolved through
// configResolver.getInstanceSetting() (platformCapabilities.js
// PERPLEXITY_MODEL), called fresh on every callPerplexityApi() call.
// Instance-scoped only, not per-org: every live caller (perplexitySearch/
// Research/Verify in agentTools.js) already passes an explicit model, so
// this default is a genuine but rarely-hit fallback — see this key's own
// registry-entry note for why org-scoping it isn't done in this slice.
function getPerplexityDefaultModel() {
  return configResolver.getInstanceSetting('PERPLEXITY_MODEL').value || PERPLEXITY_DEFAULT_MODEL;
}

// VAULT-INTEG P3: PERPLEXITY_API_KEY was env-only despite 'perplexity'
// already being in the vault resolver's PROVIDER_TYPE_MAP/PROVIDER_KEY_FIELDS
// (services/auth/services/credentialResolver.js, services/collector/lib/
// providerKeysMerge.js). Callers now resolve the org's key via the same
// getProviderKeys()/providerKeys.js path the other LLM providers use (see
// agentTools.js's resolvePerplexityApiKey) and pass it through as
// `apiKeyOverride`; reading process.env.PERPLEXITY_API_KEY here stays the
// last-resort fallback when no per-call key is supplied.
function getApiKey(apiKeyOverride) {
  return apiKeyOverride || process.env.PERPLEXITY_API_KEY || '';
}

// Mutable reference for testing — tests can replace via _setFetch()
let _fetchFn = globalThis.fetch;

/**
 * Low-level Perplexity API caller.
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {Object} options - { model, timeout, return_citations, search_domain_filter, search_recency_filter, search_mode }
 * @returns {Promise<{ success: boolean, content?: string, citations?: string[], search_results?: object[], related_questions?: string[], model_used?: string, usage?: object, error?: string }>}
 */
async function callPerplexityApi(messages, options = {}) {
  const apiKey = getApiKey(options.apiKey);
  if (!apiKey) {
    return { success: false, error: 'Perplexity API key not configured. Set PERPLEXITY_API_KEY.' };
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return { success: false, error: 'Messages array is required and must not be empty.' };
  }

  const model = options.model || getPerplexityDefaultModel();
  const timeout = options.timeout || getPerplexityTimeoutMs();

  const body = {
    model,
    messages,
    return_citations: options.return_citations !== false,
  };

  // Optional search parameters
  if (options.search_domain_filter && Array.isArray(options.search_domain_filter)) {
    body.search_domain_filter = options.search_domain_filter;
  }
  if (options.search_recency_filter) {
    body.search_recency_filter = options.search_recency_filter;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await _fetchFn(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 401) {
        return { success: false, error: 'Perplexity API authentication failed. Check PERPLEXITY_API_KEY.' };
      }
      if (resp.status === 429) {
        return { success: false, error: 'Perplexity API rate limit exceeded. Try again later.' };
      }
      return { success: false, error: `Perplexity API returned ${resp.status}: ${text.substring(0, 500)}` };
    }

    const data = await resp.json();

    const choice = data.choices?.[0];
    const content = choice?.message?.content || '';
    const citations = data.citations || [];
    const search_results = data.search_results || [];
    const related_questions = data.related_questions || [];

    return {
      success: true,
      content,
      citations,
      search_results,
      related_questions,
      model_used: data.model || model,
      usage: data.usage || null
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { success: false, error: `Perplexity API timed out after ${timeout}ms.` };
    }
    return { success: false, error: `Perplexity API request failed: ${err.message}` };
  }
}

/**
 * Web search with citations using Perplexity Sonar.
 * @param {Object} input - { query, domain_filter, recency, max_results }
 * @param {string} [apiKeyOverride] - per-call API key (vault-resolved by the
 *   caller — see agentTools.js). Falls back to process.env.PERPLEXITY_API_KEY.
 * @returns {Promise<Object>}
 */
async function perplexitySearch(input, apiKeyOverride) {
  const { query, domain_filter, recency } = input;

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return { success: false, error: 'query parameter is required.' };
  }

  if (query.length > PERPLEXITY_MAX_QUERY_LENGTH) {
    return { success: false, error: `Query exceeds maximum length (${PERPLEXITY_MAX_QUERY_LENGTH} chars).` };
  }

  const options = {
    model: 'sonar',
    return_citations: true,
  };

  if (domain_filter && Array.isArray(domain_filter)) {
    options.search_domain_filter = domain_filter;
  }
  if (recency && ['hour', 'day', 'week', 'month'].includes(recency)) {
    options.search_recency_filter = recency;
  }
  if (apiKeyOverride) options.apiKey = apiKeyOverride;

  const messages = [
    { role: 'system', content: 'You are a helpful web search assistant. Provide accurate, well-sourced answers with citations. Include relevant URLs and source references.' },
    { role: 'user', content: query }
  ];

  const result = await callPerplexityApi(messages, options);
  return { ...result, tool: 'perplexity_search' };
}

/**
 * Deep multi-source research using Perplexity Sonar Pro.
 * @param {Object} input - { topic, mode, depth, focus }
 * @param {string} [apiKeyOverride] - per-call API key (vault-resolved by the
 *   caller). Falls back to process.env.PERPLEXITY_API_KEY.
 * @returns {Promise<Object>}
 */
async function perplexityResearch(input, apiKeyOverride) {
  const { topic, mode, depth, focus } = input;

  if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
    return { success: false, error: 'topic parameter is required.' };
  }

  if (topic.length > PERPLEXITY_MAX_QUERY_LENGTH) {
    return { success: false, error: `Topic exceeds maximum length (${PERPLEXITY_MAX_QUERY_LENGTH} chars).` };
  }

  // Model selection based on depth
  let model = 'sonar-pro';
  if (depth === 'deep') {
    model = 'sonar-deep-research';
  }

  const searchMode = mode === 'academic' ? 'academic' : 'web';
  const focusHint = focus ? `\nFocus area: ${focus}` : '';

  const systemContent = searchMode === 'academic'
    ? 'You are an academic research assistant. Search scholarly sources, papers, and academic databases. Cite DOIs and paper titles where available.'
    : 'You are a thorough research assistant. Search multiple sources comprehensively. Provide well-structured findings with citations and source URLs.';

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: `Research the following topic thoroughly:\n\n${topic}${focusHint}` }
  ];

  const result = await callPerplexityApi(messages, { model, return_citations: true, apiKey: apiKeyOverride });
  return { ...result, tool: 'perplexity_research', mode: searchMode, depth: depth || 'standard' };
}

/**
 * Fact-check a claim against web sources using Perplexity Sonar Reasoning.
 * @param {Object} input - { claim, context, sources }
 * @param {string} [apiKeyOverride] - per-call API key (vault-resolved by the
 *   caller). Falls back to process.env.PERPLEXITY_API_KEY.
 * @returns {Promise<Object>}
 */
async function perplexityVerify(input, apiKeyOverride) {
  const { claim, context, sources } = input;

  if (!claim || typeof claim !== 'string' || claim.trim().length === 0) {
    return { success: false, error: 'claim parameter is required.' };
  }

  const contextHint = context ? `\nAdditional context: ${context}` : '';
  const sourcesHint = sources && Array.isArray(sources) && sources.length > 0
    ? `\nSuggested sources to check: ${sources.join(', ')}`
    : '';

  const messages = [
    {
      role: 'system',
      content: 'You are a fact-checking assistant. Verify claims against current web sources. For each claim, provide:\n1. **Verdict**: TRUE, FALSE, PARTIALLY TRUE, or UNVERIFIABLE\n2. **Confidence**: HIGH, MEDIUM, or LOW\n3. **Evidence**: Key facts supporting your verdict with source URLs\n4. **Nuance**: Important caveats or context'
    },
    {
      role: 'user',
      content: `Fact-check the following claim:\n\n"${claim}"${contextHint}${sourcesHint}`
    }
  ];

  const result = await callPerplexityApi(messages, { model: 'sonar-reasoning', return_citations: true, apiKey: apiKeyOverride });
  return { ...result, tool: 'perplexity_verify' };
}

module.exports = {
  callPerplexityApi,
  perplexitySearch,
  perplexityResearch,
  perplexityVerify,
  PERPLEXITY_API_URL,
  PERPLEXITY_DEFAULT_MODEL,
  PERPLEXITY_TIMEOUT_MS,
  getPerplexityTimeoutMs,
  getPerplexityDefaultModel,
  PERPLEXITY_MAX_QUERY_LENGTH,
  // Test helper — allows tests to inject a mock fetch
  _setFetch: (fn) => { _fetchFn = fn; },
  _resetFetch: () => { _fetchFn = globalThis.fetch; },
};
