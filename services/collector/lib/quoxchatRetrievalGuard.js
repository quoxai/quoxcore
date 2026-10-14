/**
 * QuoxChat retrieval guard (wave 10 #5). A dense search that errors or times
 * out used to look identical to "nothing documented" (rag_chunks [] and an
 * "I do not have information" answer). The search is retried once; if it
 * still fails the failure is reported so the caller can fall back to
 * lexical-only retrieval, record retrieval_error, and never claim the
 * business has no information.
 */

const RETRIEVAL_FAILED_REPLY = "I couldn't check our information just now, please try again in a moment, or ask to speak with the team.";

/**
 * @param {() => Promise<Array>} searchOnce throws on any failure
 * @returns {Promise<{chunks: Array, error: string|null, attempts: number}>}
 */
async function searchWithRetry(searchOnce, { retries = 1 } = {}) {
  let lastErr = null;
  let attempts = 0;
  for (let i = 0; i <= retries; i++) {
    attempts++;
    try {
      const chunks = await searchOnce();
      return { chunks: Array.isArray(chunks) ? chunks : [], error: null, attempts };
    } catch (err) {
      lastErr = err;
    }
  }
  return { chunks: [], error: String((lastErr && lastErr.message) || lastErr || 'retrieval_failed').slice(0, 160), attempts };
}

/** True when the turn should be answered with the honest lookup-failed text. */
function shouldReportRetrievalFailure({ retrievalError, keptCount, message }) {
  if (!retrievalError || keptCount > 0) return false;
  const words = String(message || '').trim().split(/\s+/).filter(Boolean);
  return words.length >= 3;
}

module.exports = { RETRIEVAL_FAILED_REPLY, searchWithRetry, shouldReportRetrievalFailure };
