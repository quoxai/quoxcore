/**
 * Quox Vector Memory Service
 *
 * Integrates with Qdrant vector database for semantic search of memories.
 * Uses OpenAI embeddings for semantic similarity (Wave 1 Memory Overhaul).
 */

import {
  getEmbedding,
  getEmbeddings,
  isAvailable as embeddingsAvailable,
  getStats as getEmbeddingStats,
  EMBEDDING_DIMENSION
} from './embeddingService.js'

// Qdrant configuration - override via VITE_QDRANT_URL and VITE_QDRANT_API_KEY env vars
const QDRANT_URL = import.meta.env.VITE_QDRANT_URL || '/qdrant'
const QDRANT_API_KEY = import.meta.env.VITE_QDRANT_API_KEY || ''
const COLLECTION_NAME = 'memories'
const EMBEDDING_DIM = EMBEDDING_DIMENSION  // 1536 from OpenAI

/**
 * Get headers for Qdrant requests (includes API key if configured)
 */
function getQdrantHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  if (QDRANT_API_KEY) {
    headers['api-key'] = QDRANT_API_KEY
  }
  return headers
}

// Memory types for filtering
export const MEMORY_TYPES = {
  EPISODIC: 'episodic',
  FACT: 'fact',
  PREFERENCE: 'preference',
  CONSTRAINT: 'constraint',
  PROJECT: 'project',
  DECISION: 'decision'
}

/**
 * Generate embedding for text
 * Now uses OpenAI embeddings via embeddingService (with fallback)
 */
async function generateEmbedding(text) {
  const embedding = await getEmbedding(text)
  return embedding || generateFallbackEmbedding(text)
}

/**
 * Fallback embedding when OpenAI unavailable
 * Hash-based sparse vector (kept for offline/fallback use)
 */
function generateFallbackEmbedding(text) {
  const normalized = text.toLowerCase().trim()
  const words = normalized.split(/\s+/)

  const vector = new Float32Array(EMBEDDING_DIM).fill(0)

  for (const word of words) {
    let hash = 0
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash) + word.charCodeAt(i)
      hash = hash & hash
    }

    const dim1 = Math.abs(hash) % EMBEDDING_DIM
    const dim2 = Math.abs(hash * 31) % EMBEDDING_DIM
    const dim3 = Math.abs(hash * 37) % EMBEDDING_DIM

    vector[dim1] += 0.5
    vector[dim2] += 0.3
    vector[dim3] += 0.2
  }

  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0))
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= magnitude
    }
  }

  return Array.from(vector)
}

/**
 * Check if semantic embeddings are available
 */
export function hasSemanticEmbeddings() {
  return embeddingsAvailable()
}

/**
 * Check if Qdrant is available
 */
export async function checkQdrantHealth() {
  try {
    const response = await fetch(`${QDRANT_URL}/health`, {
      headers: getQdrantHeaders()
    })
    return response.ok
  } catch (e) {
    return false
  }
}

/**
 * Ensure the memories collection exists
 */
export async function ensureCollection() {
  try {
    // Check if collection exists
    const checkResponse = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
      headers: getQdrantHeaders()
    })

    if (checkResponse.status === 404) {
      // Create collection
      const createResponse = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
        method: 'PUT',
        headers: getQdrantHeaders(),
        body: JSON.stringify({
          vectors: {
            size: EMBEDDING_DIM,
            distance: 'Cosine'
          }
        })
      })

      if (!createResponse.ok) {
        throw new Error(`Failed to create collection: ${createResponse.statusText}`)
      }

      console.log('Created memories collection')
      return true
    }

    return true
  } catch (e) {
    console.error('Qdrant collection error:', e)
    return false
  }
}

/**
 * Store a memory in the vector database
 */
export async function storeMemory(memory) {
  const {
    id,
    content,
    type,
    agent,
    timestamp,
    metadata = {}
  } = memory

  // Use semantic embeddings (async)
  const embedding = await generateEmbedding(content)

  try {
    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points`, {
      method: 'PUT',
      headers: getQdrantHeaders(),
      body: JSON.stringify({
        points: [{
          id: typeof id === 'string' ? hashStringToInt(id) : id,
          vector: embedding,
          payload: {
            content,
            type,
            agent,
            timestamp: timestamp || Date.now(),
            original_id: id,
            ...metadata
          }
        }]
      })
    })

    if (!response.ok) {
      throw new Error(`Failed to store memory: ${response.statusText}`)
    }

    return true
  } catch (e) {
    console.error('Failed to store memory:', e)
    return false
  }
}

/**
 * Search for similar memories
 */
export async function searchMemories(query, options = {}) {
  const {
    limit = 5,
    type = null,
    agent = null,
    minScore = 0.5,
    orgId = null
  } = options || {}

  // quox#571 Part 4 — FAIL-CLOSED cross-tenant guard.
  // This browser vector path is RETIRED (hasSemanticSearch is false for every
  // tier). It stores into and searches a single global qdrant collection with
  // NO org_id in the payload or the filter, so running it without an org_id
  // filter would return other tenants' memories. If anyone re-enables the
  // feature later, this throw forces them to pass an org_id (and to add the
  // matching org_id to the stored payload + collection filter) rather than
  // silently crossing tenants. Do not remove without server-side per-org
  // embeddings + filtering in place. See #571.
  if (!orgId) {
    throw new Error(
      'vectorMemory.searchMemories: org_id filter is required (cross-tenant guard, quox#571). ' +
      'This browser vector path is retired pending server-side embeddings + per-org qdrant filtering.'
    )
  }

  // Use semantic embeddings (async)
  const embedding = await generateEmbedding(query)

  // Build filter — org_id is mandatory (guarded above) and always first.
  const filter = { must: [{ key: 'org_id', match: { value: orgId } }] }
  if (type) {
    filter.must.push({ key: 'type', match: { value: type } })
  }
  if (agent) {
    filter.must.push({ key: 'agent', match: { value: agent } })
  }

  try {
    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`, {
      method: 'POST',
      headers: getQdrantHeaders(),
      body: JSON.stringify({
        vector: embedding,
        limit,
        score_threshold: minScore,
        filter: filter.must.length > 0 ? filter : undefined,
        with_payload: true
      })
    })

    if (!response.ok) {
      throw new Error(`Search failed: ${response.statusText}`)
    }

    const data = await response.json()
    return data.result.map(r => ({
      ...r.payload,
      score: r.score
    }))
  } catch (e) {
    console.error('Memory search failed:', e)
    return []
  }
}

/**
 * Delete a memory by ID
 */
export async function deleteMemory(id) {
  try {
    const numericId = typeof id === 'string' ? hashStringToInt(id) : id

    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/delete`, {
      method: 'POST',
      headers: getQdrantHeaders(),
      body: JSON.stringify({
        points: [numericId]
      })
    })

    return response.ok
  } catch (e) {
    console.error('Failed to delete memory:', e)
    return false
  }
}

/**
 * Get collection statistics
 */
export async function getCollectionStats() {
  try {
    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
      headers: getQdrantHeaders()
    })

    if (!response.ok) {
      return null
    }

    const data = await response.json()
    return {
      vectorCount: data.result.vectors_count,
      indexedCount: data.result.indexed_vectors_count,
      segmentsCount: data.result.segments_count,
      status: data.result.status
    }
  } catch (e) {
    console.error('Failed to get stats:', e)
    return null
  }
}

/**
 * Batch store multiple memories
 */
export async function storeMemories(memories) {
  // Get all embeddings in batch (more efficient)
  const contents = memories.map(m => m.content)
  const embeddings = await getEmbeddings(contents)

  const points = memories.map((m, i) => ({
    id: typeof m.id === 'string' ? hashStringToInt(m.id) : m.id,
    vector: embeddings[i] || generateFallbackEmbedding(m.content),
    payload: {
      content: m.content,
      type: m.type,
      agent: m.agent,
      timestamp: m.timestamp || Date.now(),
      original_id: m.id,
      ...(m.metadata || {})
    }
  }))

  try {
    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points`, {
      method: 'PUT',
      headers: getQdrantHeaders(),
      body: JSON.stringify({ points })
    })

    return response.ok
  } catch (e) {
    console.error('Failed to batch store memories:', e)
    return false
  }
}

/**
 * Helper: Convert string to integer hash for Qdrant ID
 */
function hashStringToInt(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash)
}

/**
 * VectorMemory class for managing vector-based memory operations
 */
export class VectorMemory {
  constructor() {
    this.initialized = false
  }

  async init() {
    const healthy = await checkQdrantHealth()
    if (!healthy) {
      console.warn('Qdrant not available - vector memory disabled')
      return false
    }

    await ensureCollection()
    this.initialized = true
    return true
  }

  async store(memory) {
    if (!this.initialized) return false
    return storeMemory(memory)
  }

  async search(query, options) {
    if (!this.initialized) return []
    return searchMemories(query, options)
  }

  async delete(id) {
    if (!this.initialized) return false
    return deleteMemory(id)
  }

  async getStats() {
    if (!this.initialized) return null
    return getCollectionStats()
  }

  async batchStore(memories) {
    if (!this.initialized) return false
    return storeMemories(memories)
  }
}

// Singleton instance
let vectorMemoryInstance = null

export function getVectorMemory() {
  if (!vectorMemoryInstance) {
    vectorMemoryInstance = new VectorMemory()
  }
  return vectorMemoryInstance
}

export default VectorMemory
