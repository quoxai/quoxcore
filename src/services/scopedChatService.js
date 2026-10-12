/**
 * Scoped Chat Service
 *
 * Provides folder-scoped chat with RAG (Retrieval Augmented Generation):
 * - Builds context from files in a folder
 * - Performs hybrid search (keyword + semantic)
 * - Formats responses with citation markers
 *
 * Premium features (semantic search) require Advanced Memory plugin.
 */

import { listFiles, getFile, getFolder } from './fileStorage'
import { isPremiumFilesAvailable, semanticFileSearch, isHybridSearchAvailable } from './fileMemoryBridge'
import { hasSemanticEmbeddings } from './vectorMemory'
import {
  getFolderPersonality,
  getPersonalityPrompt,
  generateFolderPersonality,
  needsPersonalityRefresh
} from './folderPersonality'

// Max content length to include in context (in characters)
const MAX_CONTEXT_LENGTH = 50000
const MAX_FILE_CONTENT = 10000

/**
 * Build context from files in a folder
 *
 * @param {string} folderPath - Folder path to scope
 * @param {Object} options - Options
 * @param {boolean} options.recursive - Include subfolders (default: false)
 * @param {string} options.query - Optional query to filter relevant files
 * @returns {Object} Context with file summaries and references
 */
export async function buildFolderContext(folderPath, options = {}) {
  const { recursive = false, query = null } = options

  // Get files in folder
  const files = listFiles({
    folderPath,
    recursive,
    sortBy: 'date'
  })

  if (files.length === 0) {
    return {
      isEmpty: true,
      folderPath,
      fileCount: 0,
      context: '',
      references: []
    }
  }

  // Get folder metadata
  const folder = getFolder(folderPath)

  // Build references array with file info
  const references = files.map((file, index) => ({
    id: file.id,
    index: index + 1,
    name: file.name,
    type: file.type,
    category: file.category,
    size: file.size,
    folderPath: file.folderPath,
    uploadedAt: file.uploadedAt
  }))

  // Build context string
  let context = `## Folder: ${folder?.name || folderPath}\n`
  context += `Files: ${files.length}\n\n`

  // Add file summaries
  let totalLength = context.length
  const includedFiles = []

  for (const file of files) {
    // Only process text-based files for context
    if (!isTextFile(file.type)) {
      continue
    }

    const fileData = getFile(file.id)
    if (!fileData?.data) continue

    try {
      const textContent = extractTextContent(fileData.data, file.type)
      if (!textContent) continue

      // Truncate if too long
      const truncated = textContent.length > MAX_FILE_CONTENT
        ? textContent.substring(0, MAX_FILE_CONTENT) + '...[truncated]'
        : textContent

      // Check if adding this would exceed max
      if (totalLength + truncated.length + 100 > MAX_CONTEXT_LENGTH) {
        break
      }

      const refIndex = references.findIndex(r => r.id === file.id)
      context += `### [${refIndex + 1}] ${file.name}\n`
      context += truncated + '\n\n'

      totalLength += truncated.length + file.name.length + 20
      includedFiles.push(file.id)
    } catch (err) {
      console.warn(`[ScopedChat] Failed to extract content from ${file.name}:`, err)
    }
  }

  // Get or generate folder personality
  let folderPersonality = getFolderPersonality(folderPath)
  if (!folderPersonality || needsPersonalityRefresh(folderPath)) {
    // Generate personality in background (don't await for faster response)
    generateFolderPersonality(folderPath).catch(console.warn)
  }

  return {
    isEmpty: false,
    folderPath,
    fileCount: files.length,
    includedCount: includedFiles.length,
    context,
    references,
    folderPersonality: folderPersonality?.summary || folder?.personality || null,
    folderTopics: folderPersonality?.topics || [],
    customInstructions: folderPersonality?.customInstructions || null
  }
}

/**
 * Search files in folder using hybrid search
 * Uses semantic search (BM25 + vector + RRF) when available, falls back to keyword
 *
 * @param {string} query - Search query
 * @param {string} folderPath - Folder to search in
 * @param {Object} options - Search options
 * @returns {Array} Search results with scores and snippets
 */
export async function searchFolderFiles(query, folderPath, options = {}) {
  const { recursive = false, limit = 5 } = options

  // Try semantic hybrid search if available
  if (isHybridSearchAvailable()) {
    try {
      const semanticResults = await semanticFileSearch(query, {
        limit,
        folderPath,
        recursive
      })

      if (!semanticResults.blocked && semanticResults.results?.length > 0) {
        // Map to expected format
        return semanticResults.results.map(r => ({
          file: {
            id: r.fileId,
            name: r.fileName,
            folderPath: r.folderPath
          },
          score: r.score,
          snippet: r.snippet || r.fileName,
          searchType: semanticResults.searchType
        }))
      }
    } catch (err) {
      console.warn('[ScopedChat] Semantic search failed, falling back to keyword:', err)
    }
  }

  // Fallback to basic keyword search
  const files = listFiles({
    folderPath,
    recursive
  })

  if (files.length === 0) {
    return []
  }

  const results = []
  const queryLower = query.toLowerCase()
  const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2)

  // Score each file
  for (const file of files) {
    let score = 0
    let matchedContent = ''

    // Filename match
    const nameLower = file.name.toLowerCase()
    if (nameLower.includes(queryLower)) {
      score += 0.5
    }
    queryTerms.forEach(term => {
      if (nameLower.includes(term)) score += 0.1
    })

    // Content match for text files
    if (isTextFile(file.type)) {
      const fileData = getFile(file.id)
      if (fileData?.data) {
        try {
          const textContent = extractTextContent(fileData.data, file.type)
          if (textContent) {
            const contentLower = textContent.toLowerCase()

            // Full query match
            if (contentLower.includes(queryLower)) {
              score += 0.3

              // Extract snippet around match
              const matchIndex = contentLower.indexOf(queryLower)
              const start = Math.max(0, matchIndex - 50)
              const end = Math.min(textContent.length, matchIndex + query.length + 100)
              matchedContent = textContent.substring(start, end)
            }

            // Term matches
            queryTerms.forEach(term => {
              if (contentLower.includes(term)) score += 0.05
            })
          }
        } catch {
          // Skip files that can't be read
        }
      }
    }

    if (score > 0) {
      results.push({
        file,
        score,
        snippet: matchedContent || file.name,
        searchType: 'keyword'
      })
    }
  }

  // Sort by score and limit
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

/**
 * Format a response with citations
 *
 * @param {string} response - AI response text
 * @param {Array} usedReferences - Array of reference indices used
 * @param {Array} allReferences - All available references
 * @returns {Object} Formatted response with citations
 */
export function formatWithCitations(response, usedReferences, allReferences) {
  // Extract citation markers from response
  const citationPattern = /\[(\d+)\]/g
  const citedIndices = new Set()

  let match
  while ((match = citationPattern.exec(response)) !== null) {
    citedIndices.add(parseInt(match[1], 10))
  }

  // Build citations array
  const citations = []
  citedIndices.forEach(index => {
    const ref = allReferences.find(r => r.index === index)
    if (ref) {
      citations.push(ref)
    }
  })

  return {
    text: response,
    citations,
    hasCitations: citations.length > 0
  }
}

/**
 * Generate a grounded prompt for folder-scoped chat
 *
 * @param {string} query - User's query
 * @param {Object} folderContext - Context from buildFolderContext
 * @returns {string} System prompt for grounded responses
 */
export function generateGroundedPrompt(query, folderContext) {
  if (folderContext.isEmpty) {
    return `The folder "${folderContext.folderPath}" is empty. There are no files to reference.

User query: ${query}

Respond by letting the user know the folder is empty and suggesting they upload some files first.`
  }

  let prompt = `You are answering questions based ONLY on the content of files in the folder "${folderContext.folderPath}".

## Rules:
1. ONLY use information from the provided files
2. Cite sources using [1], [2], etc. markers
3. If the answer is not in the files, say "I don't have information about that in these files"
4. Be concise but thorough

## Available Files:
`

  folderContext.references.forEach(ref => {
    prompt += `[${ref.index}] ${ref.name} (${ref.category})\n`
  })

  prompt += `\n## File Contents:\n${folderContext.context}\n`

  // Add folder personality context
  if (folderContext.folderPersonality) {
    prompt += `\n## Folder Context:\n${folderContext.folderPersonality}\n`
  }

  // Add topic hints
  if (folderContext.folderTopics?.length > 0) {
    prompt += `\n## Key Topics:\n${folderContext.folderTopics.join(', ')}\n`
  }

  // Add custom instructions
  if (folderContext.customInstructions) {
    prompt += `\n## Special Instructions:\n${folderContext.customInstructions}\n`
  }

  prompt += `\n## User Query:\n${query}\n`

  prompt += `\nProvide a grounded answer with citations. Every factual claim should cite a source file.`

  return prompt
}

/**
 * Check if semantic search is available for files
 */
export function canUseSemanticSearch() {
  return isPremiumFilesAvailable() && hasSemanticEmbeddings()
}

/**
 * Get folder chat status
 */
export function getFolderChatStatus(folderPath) {
  const files = listFiles({ folderPath })
  const textFiles = files.filter(f => isTextFile(f.type))

  return {
    totalFiles: files.length,
    textFiles: textFiles.length,
    canChat: textFiles.length > 0,
    hasSemanticSearch: canUseSemanticSearch(),
    premiumRequired: !isPremiumFilesAvailable() && hasSemanticEmbeddings()
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Check if file type is text-based
 */
function isTextFile(mimeType) {
  const textTypes = [
    'text/plain',
    'text/markdown',
    'application/json',
    'text/csv',
    'text/html',
    'text/xml',
    'application/xml'
  ]
  return textTypes.includes(mimeType)
}

/**
 * Extract text content from base64 data
 */
function extractTextContent(base64Data, mimeType) {
  try {
    // Remove data URL prefix if present
    const base64Content = base64Data.includes(',')
      ? base64Data.split(',')[1]
      : base64Data

    // Decode base64
    const text = atob(base64Content)

    // For JSON, pretty print
    if (mimeType === 'application/json') {
      try {
        const parsed = JSON.parse(text)
        return JSON.stringify(parsed, null, 2)
      } catch {
        return text
      }
    }

    return text
  } catch (err) {
    console.warn('[ScopedChat] Failed to decode content:', err)
    return null
  }
}

export default {
  buildFolderContext,
  searchFolderFiles,
  formatWithCitations,
  generateGroundedPrompt,
  canUseSemanticSearch,
  getFolderChatStatus
}
