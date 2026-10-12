/**
 * Semantic Router — Embedding-based agent classification
 *
 * Uses @xenova/transformers to compute query embeddings and compare
 * against pre-computed agent utterance embeddings via cosine similarity.
 *
 * Two modes:
 *   1. Lightweight (default) — Word-overlap + n-gram similarity. No model needed.
 *   2. Semantic (opt-in)    — Full transformer embeddings. Lazy-loads model on first use.
 *
 * The semantic mode downloads all-MiniLM-L6-v2 (~23MB, cached after first load).
 * Query embedding takes ~20-50ms after model is loaded.
 */

import AGENT_ROUTES from '../config/agentRoutes.js'

// ── Model state (lazy-loaded) ───────────────────────────────────────────

let extractor = null
let modelLoading = false
let modelReady = false
let agentEmbeddings = null // Map<agentId, number[][]>

/**
 * Load the embedding model. Called once, on first semantic query.
 * Subsequent calls return immediately.
 */
async function loadModel() {
  if (modelReady) return
  if (modelLoading) {
    // Wait for in-flight load
    while (modelLoading && !modelReady) {
      await new Promise(r => setTimeout(r, 100))
    }
    return
  }
  modelLoading = true

  try {
    const { pipeline } = await import('@xenova/transformers')
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
    })
    await buildAgentEmbeddings()
    modelReady = true
    console.log('[SemanticRouter] Model loaded, agent embeddings computed')
  } catch (err) {
    console.warn('[SemanticRouter] Model load failed:', err.message)
    modelLoading = false
    throw err
  }
}

/**
 * Pre-compute embeddings for all agent utterances.
 */
async function buildAgentEmbeddings() {
  agentEmbeddings = new Map()

  for (const route of AGENT_ROUTES) {
    const embeddings = []
    for (const utterance of route.utterances) {
      const output = await extractor(utterance, { pooling: 'mean', normalize: true })
      embeddings.push(Array.from(output.data))
    }
    agentEmbeddings.set(route.agentId, embeddings)
  }
}

// ── Vector math ─────────────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors.
 * Assumes normalized vectors (dot product = cosine similarity).
 */
function cosineSimilarity(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
  }
  return dot
}

// ── Lightweight mode (word overlap + n-gram) ────────────────────────────

/**
 * Tokenize a string into lowercase words, stripping punctuation.
 */
function tokenize(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean)
}

/**
 * Generate character n-grams from text.
 */
function ngrams(text, n = 3) {
  const lower = text.toLowerCase().replace(/[^\w\s]/g, '')
  const grams = new Set()
  for (let i = 0; i <= lower.length - n; i++) {
    grams.add(lower.slice(i, i + n))
  }
  return grams
}

/**
 * Jaccard similarity between two sets.
 */
function jaccard(setA, setB) {
  let intersection = 0
  for (const item of setA) {
    if (setB.has(item)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Compute lightweight similarity between query and utterance.
 * Combines word overlap (60%) and character n-gram overlap (40%).
 */
function lightweightSimilarity(queryTokens, queryNgrams, utterance) {
  const uttTokens = new Set(tokenize(utterance))
  const uttNgrams = ngrams(utterance)

  // Word overlap - how many query words appear in the utterance
  let wordOverlap = 0
  for (const token of queryTokens) {
    if (uttTokens.has(token)) wordOverlap++
  }
  const wordScore = queryTokens.length > 0 ? wordOverlap / queryTokens.length : 0

  // N-gram similarity - catches partial matches like "vulnerab" ~ "vulnerability"
  const ngramScore = jaccard(queryNgrams, uttNgrams)

  return wordScore * 0.6 + ngramScore * 0.4
}

/**
 * Route a query using lightweight word-overlap matching.
 * No model needed. ~1-5ms per query.
 *
 * @param {string} query
 * @returns {{ agentId: string, confidence: number, gap: number, method: string, alternatives: Array }}
 */
export function routeLightweight(query) {
  const queryTokens = tokenize(query)
  const queryNg = ngrams(query)
  const scores = []

  for (const route of AGENT_ROUTES) {
    let totalSim = 0
    let maxSim = 0
    for (const utterance of route.utterances) {
      const sim = lightweightSimilarity(queryTokens, queryNg, utterance)
      totalSim += sim
      if (sim > maxSim) maxSim = sim
    }
    const avgSim = totalSim / route.utterances.length

    // Blend: 70% best match + 30% average (rewards strong single match)
    const blended = maxSim * 0.7 + avgSim * 0.3

    scores.push({ agentId: route.agentId, confidence: blended })
  }

  scores.sort((a, b) => b.confidence - a.confidence)

  const top = scores[0]
  const runner = scores[1]
  const gap = top.confidence - (runner?.confidence || 0)

  return {
    agentId: top.agentId,
    confidence: top.confidence,
    gap,
    method: 'lightweight',
    alternatives: scores.slice(1, 4).map(s => ({ agentId: s.agentId, confidence: s.confidence })),
  }
}

// ── Semantic mode (transformer embeddings) ──────────────────────────────

/**
 * Route a query using transformer embeddings.
 * Requires model to be loaded first (lazy-loads on first call).
 * ~20-50ms per query after model load.
 *
 * @param {string} query
 * @returns {Promise<{ agentId: string, confidence: number, gap: number, method: string, alternatives: Array }>}
 */
export async function routeSemantic(query) {
  if (!modelReady) {
    await loadModel()
  }

  const output = await extractor(query, { pooling: 'mean', normalize: true })
  const queryVec = Array.from(output.data)

  const scores = []

  for (const [agentId, embeddings] of agentEmbeddings) {
    let maxSim = -1
    let totalSim = 0
    for (const uttVec of embeddings) {
      const sim = cosineSimilarity(queryVec, uttVec)
      totalSim += sim
      if (sim > maxSim) maxSim = sim
    }
    const avgSim = totalSim / embeddings.length

    // Blend: 70% best match + 30% average
    const blended = maxSim * 0.7 + avgSim * 0.3

    scores.push({ agentId, confidence: blended })
  }

  scores.sort((a, b) => b.confidence - a.confidence)

  const top = scores[0]
  const runner = scores[1]
  const gap = top.confidence - (runner?.confidence || 0)

  return {
    agentId: top.agentId,
    confidence: top.confidence,
    gap,
    method: 'semantic',
    alternatives: scores.slice(1, 4).map(s => ({ agentId: s.agentId, confidence: s.confidence })),
  }
}

// ── Public API ───────────────────────────────────────────────────────────

const EMPTY_RESULT = { agentId: 'quox', confidence: 0, gap: 0, method: 'none', alternatives: [] }

/**
 * Route a query synchronously using lightweight mode.
 * Use this from synchronous callers like selectAgent().
 *
 * @param {string} query - User query
 * @returns {{ agentId: string, confidence: number, gap: number, method: string, alternatives: Array }}
 */
export function routeQuerySync(query) {
  if (!query || query.trim().length < 3) {
    return EMPTY_RESULT
  }
  return routeLightweight(query)
}

/**
 * Route a query to the best agent (async, supports semantic mode).
 *
 * @param {string} query - User query
 * @param {Object} [options]
 * @param {boolean} [options.semantic=false] - Use transformer embeddings
 * @returns {Promise<{ agentId: string, confidence: number, gap: number, method: string, alternatives: Array }>}
 */
export async function routeQuery(query, options = {}) {
  if (!query || query.trim().length < 3) {
    return EMPTY_RESULT
  }

  if (options.semantic) {
    try {
      return await routeSemantic(query)
    } catch {
      // Fall back to lightweight if model fails to load
      return routeLightweight(query)
    }
  }

  return routeLightweight(query)
}

/**
 * Check if the semantic model is loaded and ready.
 */
export function isModelReady() {
  return modelReady
}

/**
 * Pre-load the semantic model (call early to avoid latency on first query).
 */
export async function preloadModel() {
  if (!modelReady && !modelLoading) {
    await loadModel()
  }
}

/**
 * Get the list of agent IDs that have route definitions.
 */
export function getRoutedAgents() {
  return AGENT_ROUTES.map(r => r.agentId)
}

/**
 * Get route statistics.
 */
export function getRouterStats() {
  return {
    agentCount: AGENT_ROUTES.length,
    totalUtterances: AGENT_ROUTES.reduce((sum, r) => sum + r.utterances.length, 0),
    modelReady,
    modelLoading,
  }
}

/**
 * Reset state (for testing).
 */
export function _reset() {
  extractor = null
  modelLoading = false
  modelReady = false
  agentEmbeddings = null
}
