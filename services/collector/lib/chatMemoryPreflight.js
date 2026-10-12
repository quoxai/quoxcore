/**
 * Chat Memory Pre-flight
 *
 * Searches the memory service for relevant context before sending
 * a chat message to Claude. Injects matching memories into the
 * system prompt so conversations are enriched with prior knowledge.
 *
 * Created: CLI-3d (Stream CLI Phase 3)
 */

const DEFAULT_MAX_RESULTS = 5;
const SEARCH_TIMEOUT = 2000;

/**
 * Determine whether to run the memory pre-flight.
 * Runs when no memory_context is provided and the prompt is non-empty.
 */
function shouldRunPreflight({ prompt, memory_context }) {
  if (!prompt) return false;
  if (memory_context) return false;
  return true;
}

/**
 * Search memory service for context relevant to the user's prompt.
 * Returns a formatted string for injection into the system prompt,
 * or empty string if no results or service unavailable.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - User's chat message
 * @param {string} opts.orgId - Organization ID
 * @param {string} opts.userId - User ID
 * @param {string} opts.agentId - Agent ID (scopes memory search)
 * @param {string} opts.memoryServiceUrl - Memory service base URL
 * @param {Function} [opts.fetchFn] - Optional fetch override for testing
 * @param {number} [opts.maxResults] - Max memories to include (default 5)
 * @returns {Promise<string>} Formatted memory context or empty string
 */
async function buildMemoryPreflight({
  prompt,
  orgId,
  userId,
  agentId,
  memoryServiceUrl,
  fetchFn,
  maxResults = DEFAULT_MAX_RESULTS,
}) {
  const doFetch = fetchFn || globalThis.fetch;

  try {
    const params = new URLSearchParams({
      q: prompt,
      limit: String(maxResults),
    });
    if (orgId) params.set('org_id', orgId);
    if (userId) params.set('user_id', userId);
    if (agentId) params.set('agent_id', agentId);

    const url = `${memoryServiceUrl}/api/memory/search?${params}`;
    const resp = await doFetch(url, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    });

    if (!resp.ok) return '';

    const data = await resp.json();
    const results = data.results || [];

    if (results.length === 0) return '';

    // Format as concise context lines
    const limited = results.slice(0, maxResults);
    const lines = limited.map(m => `- ${m.content}`);
    return lines.join('\n');
  } catch {
    // Memory service down or timeout — degrade gracefully
    return '';
  }
}

module.exports = {
  shouldRunPreflight,
  buildMemoryPreflight,
};
