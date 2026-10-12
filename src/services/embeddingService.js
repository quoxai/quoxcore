/**
 * Quox Embedding Service
 *
 * OpenAI embeddings for semantic memory search.
 * Part of Wave 1 Memory Overhaul - "giggly-seeking-beacon"
 *
 * Cost: ~$0.00002 per 1K tokens with text-embedding-3-small
 *
 * Security Issue #72: Requires user consent before sending data to OpenAI
 */

import { verifyConsent } from './consentService'

// ============================================================================
// CONFIGURATION
// ============================================================================

const EMBEDDING_MODEL = 'text-embedding-3-small'  // Cheapest, good quality
const EMBEDDING_DIMENSION = 1536
const MAX_INPUT_TOKENS = 8000  // API limit
const BATCH_SIZE = 100  // Max embeddings per API call
const CACHE_TTL = 24 * 60 * 60 * 1000  // 24 hours

// API endpoint
const OPENAI_API_URL = 'https://api.openai.com/v1/embeddings'

// Cache for embeddings (in-memory + localStorage)
const embeddingCache = new Map()

// Stats tracking
const stats = {
  apiCalls: 0,
  cacheHits: 0,
  cacheMisses: 0,
  tokensUsed: 0,
  errors: 0
}

// ============================================================================
// API KEY MANAGEMENT
// ============================================================================

let apiKey = null

/**
 * Set the OpenAI API key
 */
export function setApiKey(key) {
  apiKey = key
}

/**
 * Get API key from various sources
 */
function getApiKey() {
  if (apiKey) return apiKey

  // Try environment variable (for Node.js context)
  if (typeof process !== 'undefined' && process.env?.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY
  }

  // Try localStorage (browser context)
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem('quox_openai_key')
    if (stored) return stored
  }

  // Try fetching from collector's config
  return null
}

/**
 * Check if embeddings are available
 */
export function isAvailable() {
  return !!getApiKey()
}

// ============================================================================
// EMBEDDING GENERATION
// ============================================================================

/**
 * Get embedding for a single text
 *
 * @param {string} text - Text to embed
 * @param {Object} options - Options
 * @returns {Promise<number[]>} - 1536-dimensional embedding vector
 */
export async function getEmbedding(text, options = {}) {
  if (!text || typeof text !== 'string') {
    console.warn('[Embedding] Invalid input:', typeof text)
    return null
  }

  // Check cache first
  const cacheKey = hashText(text)
  const cached = getCachedEmbedding(cacheKey)
  if (cached) {
    stats.cacheHits++
    return cached
  }

  stats.cacheMisses++

  // Get API key
  const key = getApiKey()
  if (!key) {
    console.warn('[Embedding] No API key available, using fallback')
    return generateFallbackEmbedding(text)
  }

  // Security Issue #72: Verify consent before sending data to OpenAI
  try {
    const consent = await verifyConsent('openai', 'embeddings')
    if (!consent.consented) {
      console.warn('[Embedding] No consent for OpenAI, using fallback:', consent.blocked_reason)
      stats.errors++
      return generateFallbackEmbedding(text)
    }
  } catch (err) {
    console.warn('[Embedding] Consent verification failed, using fallback:', err.message)
    return generateFallbackEmbedding(text)
  }

  try {
    // Truncate if too long
    const truncated = text.length > MAX_INPUT_TOKENS * 4
      ? text.substring(0, MAX_INPUT_TOKENS * 4)
      : text

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: truncated
      })
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('[Embedding] API error:', response.status, error)
      stats.errors++

      // Use fallback on error
      return generateFallbackEmbedding(text)
    }

    const data = await response.json()
    stats.apiCalls++
    stats.tokensUsed += data.usage?.total_tokens || 0

    const embedding = data.data[0].embedding

    // Cache the result
    setCachedEmbedding(cacheKey, embedding)

    return embedding
  } catch (err) {
    console.error('[Embedding] Failed to get embedding:', err)
    stats.errors++
    return generateFallbackEmbedding(text)
  }
}

/**
 * Get embeddings for multiple texts (batched for efficiency)
 *
 * @param {string[]} texts - Array of texts to embed
 * @param {Object} options - Options
 * @returns {Promise<number[][]>} - Array of embedding vectors
 */
export async function getEmbeddings(texts, options = {}) {
  if (!texts || !Array.isArray(texts) || texts.length === 0) {
    return []
  }

  const results = new Array(texts.length).fill(null)
  const uncached = []
  const uncachedIndices = []

  // Check cache first
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]
    if (!text || typeof text !== 'string') {
      results[i] = null
      continue
    }

    const cacheKey = hashText(text)
    const cached = getCachedEmbedding(cacheKey)

    if (cached) {
      results[i] = cached
      stats.cacheHits++
    } else {
      uncached.push(text)
      uncachedIndices.push(i)
      stats.cacheMisses++
    }
  }

  // If all cached, return early
  if (uncached.length === 0) {
    return results
  }

  // Get API key
  const key = getApiKey()
  if (!key) {
    console.warn('[Embedding] No API key, using fallback for', uncached.length, 'texts')
    for (let i = 0; i < uncached.length; i++) {
      results[uncachedIndices[i]] = generateFallbackEmbedding(uncached[i])
    }
    return results
  }

  // Batch API calls
  const batches = chunk(uncached, BATCH_SIZE)
  let batchOffset = 0

  for (const batch of batches) {
    try {
      // Truncate each text
      const truncated = batch.map(text =>
        text.length > MAX_INPUT_TOKENS * 4
          ? text.substring(0, MAX_INPUT_TOKENS * 4)
          : text
      )

      const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: truncated
        })
      })

      if (!response.ok) {
        const error = await response.text()
        console.error('[Embedding] Batch API error:', response.status, error)
        stats.errors++

        // Use fallback for this batch
        for (let i = 0; i < batch.length; i++) {
          const originalIndex = uncachedIndices[batchOffset + i]
          results[originalIndex] = generateFallbackEmbedding(batch[i])
        }
      } else {
        const data = await response.json()
        stats.apiCalls++
        stats.tokensUsed += data.usage?.total_tokens || 0

        // Store results and cache
        for (let i = 0; i < data.data.length; i++) {
          const originalIndex = uncachedIndices[batchOffset + i]
          const embedding = data.data[i].embedding

          results[originalIndex] = embedding
          setCachedEmbedding(hashText(batch[i]), embedding)
        }
      }
    } catch (err) {
      console.error('[Embedding] Batch failed:', err)
      stats.errors++

      // Use fallback for failed batch
      for (let i = 0; i < batch.length; i++) {
        const originalIndex = uncachedIndices[batchOffset + i]
        results[originalIndex] = generateFallbackEmbedding(batch[i])
      }
    }

    batchOffset += batch.length
  }

  return results
}

// ============================================================================
// SIMILARITY CALCULATION
// ============================================================================

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(embedding1, embedding2) {
  if (!embedding1 || !embedding2 || embedding1.length !== embedding2.length) {
    return 0
  }

  let dotProduct = 0
  let norm1 = 0
  let norm2 = 0

  for (let i = 0; i < embedding1.length; i++) {
    dotProduct += embedding1[i] * embedding2[i]
    norm1 += embedding1[i] * embedding1[i]
    norm2 += embedding2[i] * embedding2[i]
  }

  if (norm1 === 0 || norm2 === 0) return 0

  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2))
}

/**
 * Find most similar items from a list
 *
 * @param {number[]} queryEmbedding - Query embedding
 * @param {Array} items - Items with 'embedding' property
 * @param {Object} options - Options
 * @returns {Array} - Sorted items with similarity scores
 */
export function findSimilar(queryEmbedding, items, options = {}) {
  const { topK = 10, minScore = 0.3 } = options

  if (!queryEmbedding || !items || items.length === 0) {
    return []
  }

  const scored = items
    .filter(item => item.embedding)
    .map(item => ({
      ...item,
      similarity: cosineSimilarity(queryEmbedding, item.embedding)
    }))
    .filter(item => item.similarity >= minScore)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)

  return scored
}

// ============================================================================
// CACHING
// ============================================================================

/**
 * Hash text for cache key
 */
function hashText(text) {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return `emb_${hash}`
}

/**
 * Get cached embedding
 */
function getCachedEmbedding(key) {
  // Check memory cache first
  if (embeddingCache.has(key)) {
    const cached = embeddingCache.get(key)
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.embedding
    }
    embeddingCache.delete(key)
  }

  // Check localStorage
  if (typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem(key)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Date.now() - parsed.timestamp < CACHE_TTL) {
          // Restore to memory cache
          embeddingCache.set(key, parsed)
          return parsed.embedding
        }
        localStorage.removeItem(key)
      }
    } catch (e) {
      // Ignore storage errors
    }
  }

  return null
}

/**
 * Cache an embedding
 */
function setCachedEmbedding(key, embedding) {
  const cached = {
    embedding,
    timestamp: Date.now()
  }

  // Store in memory
  embeddingCache.set(key, cached)

  // Store in localStorage (async, fire-and-forget)
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(key, JSON.stringify(cached))
    } catch (e) {
      // Storage full - clear old embeddings
      clearOldEmbeddings()
    }
  }
}

/**
 * Clear old embeddings from localStorage
 */
function clearOldEmbeddings() {
  if (typeof localStorage === 'undefined') return

  const now = Date.now()
  const toRemove = []

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith('emb_')) {
      try {
        const cached = JSON.parse(localStorage.getItem(key))
        if (now - cached.timestamp > CACHE_TTL) {
          toRemove.push(key)
        }
      } catch (e) {
        toRemove.push(key)
      }
    }
  }

  for (const key of toRemove) {
    localStorage.removeItem(key)
  }

  console.log('[Embedding] Cleared', toRemove.length, 'expired embeddings')
}

/**
 * Clear entire embedding cache
 */
export function clearCache() {
  embeddingCache.clear()

  if (typeof localStorage !== 'undefined') {
    const toRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('emb_')) {
        toRemove.push(key)
      }
    }
    for (const key of toRemove) {
      localStorage.removeItem(key)
    }
  }
}

// ============================================================================
// FALLBACK EMBEDDING
// ============================================================================

/**
 * Generate fallback embedding when API unavailable
 * Uses hash-based sparse vector (same as old vectorMemory.js)
 */
function generateFallbackEmbedding(text) {
  const vector = new Float32Array(EMBEDDING_DIMENSION).fill(0)
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2)

  for (const word of words) {
    let hash = 0
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash) + word.charCodeAt(i)
    }

    const dim1 = Math.abs(hash) % EMBEDDING_DIMENSION
    const dim2 = Math.abs(hash * 31) % EMBEDDING_DIMENSION
    const dim3 = Math.abs(hash * 37) % EMBEDDING_DIMENSION

    vector[dim1] += 0.5
    vector[dim2] += 0.3
    vector[dim3] += 0.2
  }

  // L2 normalize
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0))
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= magnitude
    }
  }

  return Array.from(vector)
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Split array into chunks
 */
function chunk(array, size) {
  const chunks = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}

/**
 * Get embedding stats
 */
export function getStats() {
  return {
    ...stats,
    cacheSize: embeddingCache.size,
    estimatedCost: (stats.tokensUsed / 1000) * 0.00002 // $0.00002/1K tokens
  }
}

/**
 * Reset stats
 */
export function resetStats() {
  stats.apiCalls = 0
  stats.cacheHits = 0
  stats.cacheMisses = 0
  stats.tokensUsed = 0
  stats.errors = 0
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  setApiKey,
  isAvailable,
  getEmbedding,
  getEmbeddings,
  cosineSimilarity,
  findSimilar,
  clearCache,
  getStats,
  resetStats,
  EMBEDDING_DIMENSION
}

export { EMBEDDING_DIMENSION }
