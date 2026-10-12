/**
 * Knowledge Pipeline Utilities (CW-4)
 *
 * Pure functions for text chunking, search scoring, FAQ matching, and content hashing.
 * These are used by both the collector (server-side RAG) and dashboard (knowledge management UI).
 *
 * Qdrant operations (embed, upsert, search) are in separate service files that call these.
 */

// ── Text Chunking ───────────────────────────────────────────────────────────

/**
 * Split text into semantic chunks with overlap.
 * Attempts to split at sentence boundaries rather than mid-sentence.
 *
 * @param {string} text — source text
 * @param {object} opts — { chunkSize: 1000, overlap: 200 }
 * @returns {Array<{text: string, index: number, start: number, end: number}>}
 */
export function chunkText(text, { chunkSize = 1000, overlap = 200 } = {}) {
  if (!text || text.length === 0) return []
  if (text.length <= chunkSize) return [{ text, index: 0, start: 0, end: text.length }]

  const chunks = []
  let pos = 0
  let index = 0

  while (pos < text.length) {
    let end = Math.min(pos + chunkSize, text.length)

    // Try to break at sentence boundary (. ! ? followed by space or end)
    if (end < text.length) {
      const searchFrom = Math.max(pos + Math.floor(chunkSize * 0.7), pos)
      let bestBreak = -1

      for (let i = end; i >= searchFrom; i--) {
        if ((text[i] === '.' || text[i] === '!' || text[i] === '?') &&
            (i + 1 >= text.length || text[i + 1] === ' ' || text[i + 1] === '\n')) {
          bestBreak = i + 1
          break
        }
      }

      if (bestBreak > pos) {
        end = bestBreak
      }
    }

    const chunkText = text.slice(pos, end).trim()
    if (chunkText.length > 0) {
      chunks.push({ text: chunkText, index, start: pos, end })
    }

    // Move forward by (end - overlap) to create overlap
    const step = Math.max(end - pos - overlap, Math.floor(chunkSize * 0.3))
    pos = pos + step
    index++

    // Safety: prevent infinite loop
    if (pos <= chunks[chunks.length - 1]?.start) break
  }

  return chunks
}


// ── Content Hashing ─────────────────────────────────────────────────────────

/**
 * Compute a deterministic hash of text content.
 * Used for diff-based re-indexing — only re-embed when content changes.
 * Normalises whitespace before hashing.
 *
 * @param {string} text
 * @returns {string} hex hash string
 */
export function computeContentHash(text) {
  // Normalise: collapse whitespace, trim
  const normalised = (text || '').replace(/\s+/g, ' ').trim()

  // Simple FNV-1a hash (fast, deterministic, no crypto dependency)
  let hash = 0x811c9dc5
  for (let i = 0; i < normalised.length; i++) {
    hash ^= normalised.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}


// ── BM25 Scoring ────────────────────────────────────────────────────────────

/**
 * Simplified BM25 score for a query against a document.
 * Used for the keyword component of hybrid search.
 *
 * @param {string} query
 * @param {string} document
 * @param {object} opts — { k1: 1.5, b: 0.75 }
 * @returns {number} score (0 = no match)
 */
export function scoreBM25(query, document, { k1 = 1.5, b = 0.75 } = {}) {
  if (!query || !document) return 0

  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const docTerms = document.toLowerCase().split(/\s+/).filter(Boolean)
  if (queryTerms.length === 0 || docTerms.length === 0) return 0

  const docLen = docTerms.length
  const avgDocLen = 100 // Assumed average (in a real system, computed across corpus)

  // Term frequency map
  const tf = {}
  for (const term of docTerms) {
    tf[term] = (tf[term] || 0) + 1
  }

  let score = 0
  for (const term of queryTerms) {
    const termFreq = tf[term] || 0
    if (termFreq === 0) continue

    // IDF approximation (assumes term appears in ~10% of docs)
    const idf = Math.log(1 + (10 - 1 + 0.5) / (1 + 0.5))

    // BM25 term score
    const numerator = termFreq * (k1 + 1)
    const denominator = termFreq + k1 * (1 - b + b * (docLen / avgDocLen))
    score += idf * (numerator / denominator)
  }

  return score
}


// ── Reciprocal Rank Fusion ──────────────────────────────────────────────────

/**
 * Combine two ranked result lists using Reciprocal Rank Fusion.
 * Standard approach for hybrid search (vector + keyword).
 *
 * @param {Array<{id: string, score: number}>} vectorResults — ranked by cosine similarity
 * @param {Array<{id: string, score: number}>} bm25Results — ranked by BM25 score
 * @param {number} k — RRF constant (default 60)
 * @returns {Array<{id: string, score: number, vectorRank?: number, bm25Rank?: number}>}
 */
export function fuseRRF(vectorResults = [], bm25Results = [], k = 60) {
  if (vectorResults.length === 0 && bm25Results.length === 0) return []

  const scores = new Map()

  // Score from vector results
  vectorResults.forEach((r, i) => {
    const rank = i + 1
    const existing = scores.get(r.id) || { id: r.id, score: 0 }
    existing.score += 1 / (k + rank)
    existing.vectorRank = rank
    scores.set(r.id, existing)
  })

  // Score from BM25 results
  bm25Results.forEach((r, i) => {
    const rank = i + 1
    const existing = scores.get(r.id) || { id: r.id, score: 0 }
    existing.score += 1 / (k + rank)
    existing.bm25Rank = rank
    scores.set(r.id, existing)
  })

  // Sort by fused score (descending)
  return Array.from(scores.values()).sort((a, b) => b.score - a.score)
}


// ── FAQ Cache Matching ──────────────────────────────────────────────────────

/**
 * Match a query against pre-computed FAQ pairs.
 * Returns the best match above the threshold, or null.
 *
 * In production, FAQ pairs have pre-computed embeddings.
 * The `similarity` field comes from cosine similarity against the query embedding.
 * This function just does the threshold check and ranking.
 *
 * @param {string} query — visitor's question
 * @param {Array<{question: string, answer: string, similarity: number}>} faqPairs — with pre-computed similarity
 * @param {number} threshold — minimum similarity to consider a match (default 0.92)
 * @returns {{question: string, answer: string, similarity: number}|null}
 */
export function matchFAQ(query, faqPairs = [], threshold = 0.92) {
  if (!query || faqPairs.length === 0) return null

  // Filter above threshold, sort by similarity descending
  const matches = faqPairs
    .filter(faq => faq.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)

  return matches.length > 0 ? matches[0] : null
}


// ── Chunk Metadata ──────────────────────────────────────────────────────────

/**
 * Build metadata for a chunk, including a source breadcrumb.
 * This breadcrumb is prepended to the chunk when injecting into LLM context,
 * helping the model understand where the information comes from.
 *
 * @param {object} opts
 * @returns {object} metadata with breadcrumb
 */
export function buildChunkMetadata({ sourceType, sourceName, sectionHeading, chunkIndex, totalChunks, sourceUrl }) {
  const parts = [sourceName]
  if (sectionHeading) parts.push(sectionHeading)

  return {
    breadcrumb: `[Source: ${parts.join(' > ')}]`,
    sourceType: sourceType || 'unknown',
    sourceName: sourceName || 'untitled',
    sectionHeading: sectionHeading || null,
    sourceUrl: sourceUrl || null,
    chunkIndex: chunkIndex ?? 0,
    totalChunks: totalChunks ?? 1,
  }
}
