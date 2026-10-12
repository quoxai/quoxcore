/**
 * FAQ Utilities (CW-8.5)
 *
 * Q&A pair handling and pinned result detection.
 */

/**
 * Build a Q&A pair payload for embedding + Qdrant upsert.
 * The text combines question and answer for embedding.
 * Metadata includes pinned:true for priority retrieval.
 */
export function buildQAPairPayload({ question, answer, widgetId, category }) {
  return {
    text: `Q: ${question}\nA: ${answer}`,
    metadata: {
      pinned: true,
      source_type: 'qa',
      source: 'FAQ',
      section: category || 'General',
      question,
      answer,
      widget_id: widgetId || 'demo',
    },
  }
}

/**
 * Check if a Qdrant search result is a pinned (FAQ) answer.
 */
export function isPinnedResult(payload) {
  return payload?.pinned === true
}

/**
 * Extract the clean answer from a pinned FAQ result.
 * Returns the answer text directly (no need for LLM to rephrase).
 */
export function extractPinnedAnswer(payload) {
  return payload?.answer || null
}
