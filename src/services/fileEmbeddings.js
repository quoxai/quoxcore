/**
 * File Embeddings Service
 *
 * Semantic search for files with proper chunking and hybrid search:
 * - Chunk content (overlap: 200 chars, size: 1000 chars)
 * - Generate embeddings via OpenAI text-embedding-3-small
 * - Store in Qdrant with file metadata
 * - Hybrid search: BM25 keyword + vector + RRF fusion
 *
 * Premium feature - requires Advanced Memory plugin.
 */

import {
  getEmbedding,
  getEmbeddings,
  isAvailable as embeddingsAvailable,
  EMBEDDING_DIMENSION
} from './embeddingService.js'
import { isPluginEnabled } from './pluginClient'

// Configuration
const QDRANT_URL = import.meta.env.VITE_QDRANT_URL || '/qdrant'
const QDRANT_API_KEY = import.meta.env.VITE_QDRANT_API_KEY || ''
const COLLECTION_NAME = 'file_chunks'
const CHUNK_SIZE = 1000  // Characters per chunk
const CHUNK_OVERLAP = 200  // Overlap between chunks
const RRF_K = 60  // RRF fusion constant

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

// In-memory BM25 index for keyword search
const bm25Index = {
  documents: new Map(),  // fileId -> { chunks: [], avgLength }
  terms: new Map(),       // term -> { docFreq, postings: Map<fileId, [chunkIndices]> }
  avgDocLength: 0,
  totalDocs: 0
}

// Text-based MIME types that can be indexed
const TEXT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'application/json',
  'text/csv',
  'text/html',
  'text/xml',
  'application/xml',
  'text/javascript',
  'application/javascript',
  'text/css'
]

/**
 * Check if semantic file search is available
 */
export function isSemanticSearchAvailable() {
  return embeddingsAvailable() && isPluginEnabled('advanced-memory')
}

/**
 * Check if a file type can be indexed
 */
export function canIndexFileType(mimeType) {
  return TEXT_MIME_TYPES.includes(mimeType)
}

/**
 * Check Qdrant health
 */
export async function checkQdrantHealth() {
  try {
    const response = await fetch(`${QDRANT_URL}/health`, {
      headers: getQdrantHeaders()
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Ensure the file_chunks collection exists
 */
export async function ensureCollection() {
  try {
    const checkResponse = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
      headers: getQdrantHeaders()
    })

    if (checkResponse.status === 404) {
      const createResponse = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
        method: 'PUT',
        headers: getQdrantHeaders(),
        body: JSON.stringify({
          vectors: {
            size: EMBEDDING_DIMENSION,
            distance: 'Cosine'
          }
        })
      })

      if (!createResponse.ok) {
        throw new Error(`Failed to create collection: ${createResponse.statusText}`)
      }

      console.log('[FileEmbeddings] Created file_chunks collection')
      return true
    }

    return true
  } catch (err) {
    console.error('[FileEmbeddings] Collection error:', err)
    return false
  }
}

/**
 * Chunk text content with overlap
 *
 * @param {string} text - Text to chunk
 * @param {Object} options - Chunking options
 * @returns {Array<{text: string, start: number, end: number}>}
 */
export function chunkText(text, options = {}) {
  const {
    chunkSize = CHUNK_SIZE,
    overlap = CHUNK_OVERLAP
  } = options

  if (!text || text.length === 0) return []

  const chunks = []
  let start = 0

  while (start < text.length) {
    let end = start + chunkSize

    // Try to break at word boundary
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(' ', end)
      if (lastSpace > start + chunkSize / 2) {
        end = lastSpace
      }
    }

    chunks.push({
      text: text.substring(start, end).trim(),
      start,
      end: Math.min(end, text.length),
      index: chunks.length
    })

    // Move start back by overlap for next chunk
    start = end - overlap
    if (start <= chunks[chunks.length - 1]?.start) {
      start = end  // Prevent infinite loop
    }
  }

  return chunks.filter(c => c.text.length > 0)
}

/**
 * Extract text content from file data
 *
 * @param {Object} fileData - File data with base64 content
 * @returns {string|null} Extracted text
 */
export function extractTextContent(fileData) {
  if (!fileData?.data) return null

  try {
    const base64Content = fileData.data.split(',')[1]
    if (!base64Content) return null

    return atob(base64Content)
  } catch (err) {
    console.warn('[FileEmbeddings] Failed to extract text:', err)
    return null
  }
}

/**
 * Index a file's content
 *
 * @param {string} fileId - File ID
 * @param {Object} fileData - File data with content
 * @param {Object} metadata - Additional metadata
 * @returns {Object} Indexing result
 */
export async function indexFile(fileId, fileData, metadata = {}) {
  if (!isSemanticSearchAvailable()) {
    return {
      indexed: false,
      reason: 'premium_required'
    }
  }

  if (!canIndexFileType(fileData?.type)) {
    return {
      indexed: false,
      reason: 'not_text_file'
    }
  }

  const textContent = extractTextContent(fileData)
  if (!textContent) {
    return {
      indexed: false,
      reason: 'no_content'
    }
  }

  // Chunk the content
  const chunks = chunkText(textContent)
  if (chunks.length === 0) {
    return {
      indexed: false,
      reason: 'empty_content'
    }
  }

  try {
    // Ensure collection exists
    await ensureCollection()

    // Generate embeddings for all chunks (batched)
    const chunkTexts = chunks.map(c => c.text)
    const embeddings = await getEmbeddings(chunkTexts)

    // Prepare points for Qdrant
    const points = chunks.map((chunk, i) => ({
      id: hashStringToInt(`${fileId}_chunk_${i}`),
      vector: embeddings[i] || generateFallbackEmbedding(chunk.text),
      payload: {
        fileId,
        fileName: fileData.name || metadata.name,
        mimeType: fileData.type,
        folderPath: metadata.folderPath || '/',
        chunkIndex: chunk.index,
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
        chunkText: chunk.text,
        totalChunks: chunks.length,
        indexedAt: Date.now()
      }
    }))

    // Store in Qdrant
    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points`, {
      method: 'PUT',
      headers: getQdrantHeaders(),
      body: JSON.stringify({ points })
    })

    if (!response.ok) {
      throw new Error(`Failed to store chunks: ${response.statusText}`)
    }

    // Update BM25 index
    updateBM25Index(fileId, chunks, metadata)

    console.log(`[FileEmbeddings] Indexed ${chunks.length} chunks for ${fileData.name}`)

    return {
      indexed: true,
      chunksCreated: chunks.length,
      contentLength: textContent.length
    }
  } catch (err) {
    console.error('[FileEmbeddings] Indexing failed:', err)
    return {
      indexed: false,
      reason: err.message
    }
  }
}

/**
 * Remove file from index
 *
 * @param {string} fileId - File ID
 */
export async function removeFileFromIndex(fileId) {
  try {
    // Remove from Qdrant
    await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/delete`, {
      method: 'POST',
      headers: getQdrantHeaders(),
      body: JSON.stringify({
        filter: {
          must: [{ key: 'fileId', match: { value: fileId } }]
        }
      })
    })

    // Remove from BM25 index
    removeBM25Entry(fileId)

    console.log(`[FileEmbeddings] Removed index for file: ${fileId}`)
  } catch (err) {
    console.warn('[FileEmbeddings] Failed to remove index:', err)
  }
}

/**
 * Vector search using Qdrant
 *
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @returns {Array} Results with scores
 */
export async function vectorSearch(query, options = {}) {
  const {
    limit = 10,
    folderPath = null,
    minScore = 0.3
  } = options

  try {
    const embedding = await getEmbedding(query)
    if (!embedding) return []

    // Build filter
    const filter = { must: [] }
    if (folderPath) {
      if (options.recursive) {
        // Match folder path prefix for recursive search
        filter.must.push({
          key: 'folderPath',
          match: { value: folderPath }
        })
        // Also include subfolders
        // Note: Qdrant doesn't support prefix matching, so we use exact match
        // For proper subfolder support, we'd need to filter client-side
      } else {
        filter.must.push({
          key: 'folderPath',
          match: { value: folderPath }
        })
      }
    }

    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`, {
      method: 'POST',
      headers: getQdrantHeaders(),
      body: JSON.stringify({
        vector: embedding,
        limit: limit * 2,  // Get extra for deduplication
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
      vectorScore: r.score
    }))
  } catch (err) {
    console.error('[FileEmbeddings] Vector search failed:', err)
    return []
  }
}

/**
 * BM25 keyword search
 *
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @returns {Array} Results with BM25 scores
 */
export function keywordSearch(query, options = {}) {
  const {
    limit = 10,
    folderPath = null
  } = options

  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return []

  const scores = new Map()  // fileId -> score
  const k1 = 1.2
  const b = 0.75

  for (const term of queryTerms) {
    const termData = bm25Index.terms.get(term)
    if (!termData) continue

    const idf = Math.log(
      (bm25Index.totalDocs - termData.docFreq + 0.5) /
      (termData.docFreq + 0.5) + 1
    )

    for (const [fileId, chunkIndices] of termData.postings) {
      const docData = bm25Index.documents.get(fileId)
      if (!docData) continue

      // Filter by folder if specified
      if (folderPath && docData.folderPath !== folderPath) continue

      // Calculate term frequency across all chunks
      const tf = chunkIndices.length
      const docLength = docData.avgLength
      const tfNorm = (tf * (k1 + 1)) /
        (tf + k1 * (1 - b + b * (docLength / bm25Index.avgDocLength)))

      const currentScore = scores.get(fileId) || 0
      scores.set(fileId, currentScore + idf * tfNorm)
    }
  }

  // Convert to array and sort
  const results = Array.from(scores.entries())
    .map(([fileId, score]) => {
      const docData = bm25Index.documents.get(fileId)
      return {
        fileId,
        fileName: docData?.fileName,
        folderPath: docData?.folderPath,
        bm25Score: score
      }
    })
    .sort((a, b) => b.bm25Score - a.bm25Score)
    .slice(0, limit)

  return results
}

/**
 * Hybrid search with RRF fusion
 *
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @returns {Array} Fused results
 */
export async function hybridSearch(query, options = {}) {
  const {
    limit = 10,
    folderPath = null,
    recursive = false
  } = options

  // Run both searches in parallel
  const [vectorResults, keywordResults] = await Promise.all([
    vectorSearch(query, { limit: limit * 2, folderPath, recursive }),
    Promise.resolve(keywordSearch(query, { limit: limit * 2, folderPath }))
  ])

  // RRF fusion
  const fusedScores = new Map()  // fileId -> { score, data }

  // Process vector results
  vectorResults.forEach((result, rank) => {
    const fileId = result.fileId
    const rrfScore = 1 / (RRF_K + rank + 1)

    if (fusedScores.has(fileId)) {
      fusedScores.get(fileId).score += rrfScore
      fusedScores.get(fileId).vectorScore = result.vectorScore
    } else {
      fusedScores.set(fileId, {
        score: rrfScore,
        vectorScore: result.vectorScore,
        data: result
      })
    }
  })

  // Process keyword results
  keywordResults.forEach((result, rank) => {
    const fileId = result.fileId
    const rrfScore = 1 / (RRF_K + rank + 1)

    if (fusedScores.has(fileId)) {
      fusedScores.get(fileId).score += rrfScore
      fusedScores.get(fileId).bm25Score = result.bm25Score
    } else {
      fusedScores.set(fileId, {
        score: rrfScore,
        bm25Score: result.bm25Score,
        data: {
          fileId: result.fileId,
          fileName: result.fileName,
          folderPath: result.folderPath
        }
      })
    }
  })

  // Sort by fused score and return top results
  const results = Array.from(fusedScores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => ({
      ...r.data,
      fusedScore: r.score,
      vectorScore: r.vectorScore,
      bm25Score: r.bm25Score
    }))

  return results
}

/**
 * Get chunks for a specific file
 *
 * @param {string} fileId - File ID
 * @returns {Array} Chunks
 */
export async function getFileChunks(fileId) {
  try {
    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/scroll`, {
      method: 'POST',
      headers: getQdrantHeaders(),
      body: JSON.stringify({
        filter: {
          must: [{ key: 'fileId', match: { value: fileId } }]
        },
        limit: 100,
        with_payload: true
      })
    })

    if (!response.ok) return []

    const data = await response.json()
    return data.result.points
      .map(p => p.payload)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
  } catch (err) {
    console.warn('[FileEmbeddings] Failed to get chunks:', err)
    return []
  }
}

/**
 * Get collection statistics
 */
export async function getStats() {
  try {
    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
      headers: getQdrantHeaders()
    })

    if (!response.ok) {
      return {
        available: false,
        vectorCount: 0,
        bm25Documents: 0,
        bm25Terms: 0
      }
    }

    const data = await response.json()
    return {
      available: true,
      vectorCount: data.result.vectors_count,
      indexedCount: data.result.indexed_vectors_count,
      bm25Documents: bm25Index.totalDocs,
      bm25Terms: bm25Index.terms.size
    }
  } catch (err) {
    return {
      available: false,
      vectorCount: 0,
      bm25Documents: bm25Index.totalDocs,
      bm25Terms: bm25Index.terms.size
    }
  }
}

// ============================================================================
// BM25 INDEX MANAGEMENT
// ============================================================================

/**
 * Tokenize text for BM25
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^\w]+/)
    .filter(t => t.length > 2)
}

/**
 * Update BM25 index for a file
 */
function updateBM25Index(fileId, chunks, metadata) {
  // Remove old entry if exists
  removeBM25Entry(fileId)

  // Calculate average chunk length
  const totalLength = chunks.reduce((sum, c) => sum + c.text.length, 0)
  const avgLength = totalLength / chunks.length

  // Store document data
  bm25Index.documents.set(fileId, {
    fileName: metadata.name,
    folderPath: metadata.folderPath || '/',
    chunks: chunks.length,
    avgLength
  })

  // Update term postings
  chunks.forEach((chunk, chunkIndex) => {
    const terms = tokenize(chunk.text)
    const uniqueTerms = new Set(terms)

    for (const term of uniqueTerms) {
      if (!bm25Index.terms.has(term)) {
        bm25Index.terms.set(term, {
          docFreq: 0,
          postings: new Map()
        })
      }

      const termData = bm25Index.terms.get(term)

      if (!termData.postings.has(fileId)) {
        termData.docFreq++
        termData.postings.set(fileId, [])
      }

      termData.postings.get(fileId).push(chunkIndex)
    }
  })

  // Update global stats
  bm25Index.totalDocs++
  updateAvgDocLength()
}

/**
 * Remove file from BM25 index
 */
function removeBM25Entry(fileId) {
  if (!bm25Index.documents.has(fileId)) return

  // Remove from term postings
  for (const [term, termData] of bm25Index.terms) {
    if (termData.postings.has(fileId)) {
      termData.postings.delete(fileId)
      termData.docFreq--

      // Remove term if no more documents
      if (termData.docFreq === 0) {
        bm25Index.terms.delete(term)
      }
    }
  }

  // Remove document
  bm25Index.documents.delete(fileId)
  bm25Index.totalDocs = Math.max(0, bm25Index.totalDocs - 1)
  updateAvgDocLength()
}

/**
 * Update average document length
 */
function updateAvgDocLength() {
  if (bm25Index.totalDocs === 0) {
    bm25Index.avgDocLength = 0
    return
  }

  let totalLength = 0
  for (const doc of bm25Index.documents.values()) {
    totalLength += doc.avgLength
  }
  bm25Index.avgDocLength = totalLength / bm25Index.totalDocs
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Hash string to integer for Qdrant ID
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
 * Generate fallback embedding when API unavailable
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

  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0))
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= magnitude
    }
  }

  return Array.from(vector)
}

/**
 * Re-index all files in a folder
 *
 * @param {string} folderPath - Folder path
 * @param {Function} getFiles - Function to get files in folder
 * @param {Function} getFileData - Function to get file data
 */
export async function reindexFolder(folderPath, getFiles, getFileData) {
  if (!isSemanticSearchAvailable()) {
    return { reindexed: 0, reason: 'premium_required' }
  }

  const files = getFiles(folderPath)
  let reindexed = 0

  for (const file of files) {
    if (canIndexFileType(file.type)) {
      const fileData = getFileData(file.id)
      if (fileData) {
        const result = await indexFile(file.id, fileData, {
          name: file.name,
          folderPath: file.folderPath
        })
        if (result.indexed) reindexed++
      }
    }
  }

  return { reindexed }
}

export default {
  isSemanticSearchAvailable,
  canIndexFileType,
  checkQdrantHealth,
  ensureCollection,
  chunkText,
  extractTextContent,
  indexFile,
  removeFileFromIndex,
  vectorSearch,
  keywordSearch,
  hybridSearch,
  getFileChunks,
  getStats,
  reindexFolder
}
