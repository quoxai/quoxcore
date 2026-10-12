/**
 * File Memory Bridge Service
 *
 * Connects file storage to the memory system:
 * - Creates file entities in entity memory
 * - Indexes file content with chunking (premium)
 * - Hybrid search: BM25 + vector + RRF fusion (premium)
 * - Tracks file references in working set memory
 *
 * Premium features require the Advanced Memory plugin.
 */

import { getMemoryManager } from './memoryManager'
import { touchEntity, getRecentEntities } from './workingSetMemory'
import { isPluginEnabled } from './pluginClient'
import {
  indexFile,
  removeFileFromIndex,
  hybridSearch,
  keywordSearch,
  isSemanticSearchAvailable,
  canIndexFileType,
  getStats as getEmbeddingStats
} from './fileEmbeddings'

// Entity type for files
export const FILE_ENTITY_TYPE = 'file'

// Relationship types for files
export const FILE_RELATIONSHIPS = {
  attachedTo: { inverse: 'hasAttachment', description: 'File attached to chat/message' },
  hasAttachment: { inverse: 'attachedTo', description: 'Chat/message has file attachment' },
  relatedTo: { inverse: 'relatedTo', description: 'File related to entity' },
  referencedIn: { inverse: 'referencesFile', description: 'File referenced in conversation' }
}

// Text-based MIME types that can be indexed
const TEXT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'application/json',
  'text/csv',
  'text/html',
  'text/xml',
  'application/xml'
]

/**
 * Check if premium file features are available
 * Premium requires the Advanced Memory plugin
 */
export function isPremiumFilesAvailable() {
  try {
    return isPluginEnabled('advanced-memory')
  } catch {
    return false
  }
}

/**
 * Create a file entity in memory
 * This works for all users (free and premium)
 *
 * @param {Object} fileMetadata - File metadata from fileStorage
 * @returns {Object|null} Created entity or null
 */
export async function createFileEntity(fileMetadata) {
  try {
    const mm = getMemoryManager()
    if (!mm) {
      console.warn('[FileMemoryBridge] Memory manager not available')
      return null
    }

    const entity = {
      type: FILE_ENTITY_TYPE,
      name: fileMetadata.name,
      attributes: {
        fileId: fileMetadata.id,
        category: fileMetadata.category,
        mimeType: fileMetadata.type,
        size: fileMetadata.size,
        sizeFormatted: formatFileSize(fileMetadata.size),
        uploadedAt: fileMetadata.uploadedAt,
        chatId: fileMetadata.chatId || null,
        messageId: fileMetadata.messageId || null,
        hasThumbnail: !!fileMetadata.thumbnail
      }
    }

    // Store the entity
    await mm.storeEntity(entity)

    // If attached to a chat, create relationship
    if (fileMetadata.chatId) {
      try {
        await mm.storeEntity({
          type: 'chat',
          name: fileMetadata.chatId,
          attributes: { hasAttachments: true }
        })
      } catch {
        // Chat entity may not exist, that's ok
      }
    }

    console.log(`[FileMemoryBridge] Created file entity: ${fileMetadata.name}`)
    return entity
  } catch (err) {
    console.warn('[FileMemoryBridge] Failed to create file entity:', err)
    return null
  }
}

/**
 * Index file content with chunking (premium only)
 * Uses fileEmbeddings service for proper chunking and hybrid search support
 *
 * @param {string} fileId - File ID
 * @param {Object} fileData - File data with content
 * @param {Object} metadata - Additional metadata (folderPath, etc.)
 * @returns {Object} Result with indexed status
 */
export async function indexFileContent(fileId, fileData, metadata = {}) {
  // Check premium status
  if (!isPremiumFilesAvailable()) {
    return {
      indexed: false,
      reason: 'premium_required',
      upgrade: {
        title: 'Semantic File Search',
        message: 'Index file content for AI search with Advanced Memory Plugin.',
        price: '$99 one-time'
      }
    }
  }

  if (!fileData || !fileData.data) {
    return { indexed: false, reason: 'no_content' }
  }

  // Only index text-based files
  if (!canIndexFileType(fileData.type)) {
    return { indexed: false, reason: 'not_text_file' }
  }

  try {
    // Use fileEmbeddings service for proper chunking
    const result = await indexFile(fileId, fileData, {
      name: fileData.name,
      folderPath: metadata.folderPath || fileData.folderPath || '/',
      ...metadata
    })

    if (result.indexed) {
      console.log(`[FileMemoryBridge] Indexed ${result.chunksCreated} chunks for: ${fileData.name}`)
    }

    return result
  } catch (err) {
    console.warn('[FileMemoryBridge] Failed to index file content:', err)
    return { indexed: false, reason: err.message }
  }
}

/**
 * Track file access in working set memory
 *
 * @param {Object} fileMetadata - File metadata
 */
export function trackFileAccess(fileMetadata) {
  try {
    touchEntity({
      type: FILE_ENTITY_TYPE,
      id: fileMetadata.id,
      name: fileMetadata.name,
      context: {
        category: fileMetadata.category,
        size: fileMetadata.size,
        lastAccessed: new Date().toISOString()
      }
    })
  } catch (err) {
    console.warn('[FileMemoryBridge] Failed to track file access:', err)
  }
}

/**
 * Search files using hybrid search (BM25 + vector + RRF fusion)
 * Falls back to keyword-only search if semantic embeddings unavailable
 *
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @returns {Object} Search results
 */
export async function semanticFileSearch(query, options = {}) {
  const {
    limit = 10,
    folderPath = null,
    recursive = false,
    keywordOnly = false
  } = options

  // Check premium status for semantic search
  if (!isPremiumFilesAvailable()) {
    return {
      results: [],
      blocked: true,
      reason: 'premium_required',
      upgrade: {
        title: 'Semantic File Search',
        message: 'Search files by content meaning with Advanced Memory Plugin.',
        price: '$99 one-time'
      }
    }
  }

  try {
    let results

    // Use keyword-only or hybrid search based on options and availability
    if (keywordOnly || !isSemanticSearchAvailable()) {
      results = keywordSearch(query, { limit, folderPath })
    } else {
      results = await hybridSearch(query, { limit, folderPath, recursive })
    }

    // Format results
    const formattedResults = results.map(r => ({
      fileId: r.fileId,
      fileName: r.fileName,
      folderPath: r.folderPath,
      score: r.fusedScore || r.bm25Score || r.vectorScore || 0,
      vectorScore: r.vectorScore,
      bm25Score: r.bm25Score,
      snippet: r.chunkText?.substring(0, 200) + '...',
      chunkIndex: r.chunkIndex
    }))

    return {
      results: formattedResults,
      searchType: keywordOnly ? 'keyword' : 'hybrid'
    }
  } catch (err) {
    console.warn('[FileMemoryBridge] Search failed:', err)
    return { results: [], reason: err.message }
  }
}

/**
 * Get recently accessed files from working set memory
 *
 * @param {number} limit - Max files to return
 * @returns {Array} Recent files
 */
export function getRecentlyAccessedFiles(limit = 5) {
  try {
    const recentEntities = getRecentEntities() || []

    // Filter to file entities
    const fileEntities = recentEntities
      .filter(e => e.type === FILE_ENTITY_TYPE)
      .slice(0, limit)

    return fileEntities.map(e => ({
      id: e.id,
      name: e.name,
      lastAccessed: e.lastMentioned,
      accessCount: e.mentionCount,
      category: e.context?.category,
      size: e.context?.size
    }))
  } catch (err) {
    console.warn('[FileMemoryBridge] Failed to get recent files:', err)
    return []
  }
}

/**
 * Get file metrics for cognitive topology
 * This is the data source for the Data Fabric implant
 *
 * Note: To avoid circular dependency with fileStorage.js,
 * this function accepts optional storage/files data or fetches lazily.
 *
 * @param {Object} options - Optional pre-fetched data
 * @returns {Object} File metrics
 */
export function getFileMetrics(options = {}) {
  try {
    // Lazy import to break circular dependency
    let storage, files
    if (options.storage && options.files) {
      storage = options.storage
      files = options.files
    } else {
      // Dynamic import for when called independently
      const fileStorageModule = window.__quoxFileStorage || {}
      storage = fileStorageModule.getStorageUsage?.() || { used: 0, max: 52428800, percent: 0, limit: 52428800 }
      files = fileStorageModule.listFiles?.() || []
    }

    const recentFiles = getRecentlyAccessedFiles(10)

    // Count by category
    const byCategory = {
      images: files.filter(f => f.category === 'image').length,
      documents: files.filter(f => f.category === 'document').length
    }

    // Count files with chat associations
    const attachedFiles = files.filter(f => f.chatId).length

    // Calculate health score based on storage usage and organization
    const storageHealth = Math.max(0, 100 - (storage.percent || 0))
    const organizationScore = files.length > 0 ? (attachedFiles / files.length) * 100 : 100
    const healthScore = Math.round((storageHealth * 0.6) + (organizationScore * 0.4))

    return {
      // Primary metrics
      totalFiles: files.length,
      healthScore,

      // Storage metrics
      storageUsed: storage.used || 0,
      storageLimit: storage.limit || storage.max || 52428800,
      storagePercent: storage.percent || 0,
      storageFormatted: `${formatFileSize(storage.used || 0)} / ${formatFileSize(storage.limit || storage.max || 52428800)}`,

      // Activity metrics
      recentlyAccessed: recentFiles.length,
      attachedToChats: attachedFiles,

      // Category breakdown
      images: byCategory.images,
      documents: byCategory.documents,

      // Feature status
      isPremium: isPremiumFilesAvailable(),
      hasSemanticSearch: isPremiumFilesAvailable()
    }
  } catch (err) {
    console.warn('[FileMemoryBridge] Failed to get file metrics:', err)
    return {
      totalFiles: 0,
      healthScore: 0,
      storageUsed: 0,
      storageLimit: 52428800,
      storagePercent: 0,
      storageFormatted: '0 B / 50 MB',
      recentlyAccessed: 0,
      attachedToChats: 0,
      images: 0,
      documents: 0,
      isPremium: false,
      hasSemanticSearch: false
    }
  }
}

/**
 * Remove file entity from memory and embeddings index
 *
 * @param {string} fileId - File ID
 * @param {string} fileName - File name
 */
export async function removeFileEntity(fileId, fileName) {
  try {
    // Remove from entity memory
    const mm = getMemoryManager()
    if (mm && typeof mm.deleteEntity === 'function') {
      await mm.deleteEntity(FILE_ENTITY_TYPE, fileName)
    }

    // Remove from embeddings index
    await removeFileFromIndex(fileId)

    console.log(`[FileMemoryBridge] Removed file entity and index: ${fileName}`)
  } catch (err) {
    console.warn('[FileMemoryBridge] Failed to remove file entity:', err)
  }
}

/**
 * Get embedding index statistics
 */
export async function getEmbeddingIndexStats() {
  return getEmbeddingStats()
}

/**
 * Check if hybrid search is available
 */
export function isHybridSearchAvailable() {
  return isSemanticSearchAvailable()
}

/**
 * Format file size for display
 *
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

export default {
  isPremiumFilesAvailable,
  createFileEntity,
  indexFileContent,
  trackFileAccess,
  semanticFileSearch,
  getRecentlyAccessedFiles,
  getFileMetrics,
  removeFileEntity,
  getEmbeddingIndexStats,
  isHybridSearchAvailable,
  FILE_ENTITY_TYPE,
  FILE_RELATIONSHIPS
}
