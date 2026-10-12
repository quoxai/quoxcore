/**
 * Claude (Anthropic) Conversation Importer
 *
 * Imports conversation history from Claude's data export (.dms files or JSON).
 * The .dms format is a ZIP archive containing conversations.json.
 *
 * Supported formats:
 * - .dms file (ZIP containing conversations.json)
 * - .zip file (same as .dms, different extension)
 * - .json file (direct conversations array)
 */

import JSZip from 'jszip'
import { hasFeature, createUpgradePrompt } from './memoryTier'
import {
  extractMemories,
  extractTopics,
  analyzeImportedStyle,
  runImportPipeline,
  generateId,
  extractTitle
} from './importShared'
import { sendConversationsToQortex, canSendToQortex } from './brain2AiHistoryClient'

// ============================================================================
// TIER GATING
// ============================================================================

export function isClaudeImportAvailable() {
  // Gates all conversation imports (ChatGPT, Claude, Gemini, Perplexity)
  const available = hasFeature('hasChatGPTImport')
  if (!available) {
    return { available: false, upgrade: createUpgradePrompt('chatgptImport') }
  }
  return { available: true }
}

// ============================================================================
// PARSING
// ============================================================================

/**
 * Parse a Claude export file (.dms, .zip, or .json)
 * @param {File|Blob} file - The uploaded file
 * @returns {Promise<{ conversations: Array, metadata: object }>}
 */
export async function parseClaudeExport(file) {
  const buffer = await file.arrayBuffer()

  // Try ZIP first (.dms is a ZIP)
  try {
    const zip = await JSZip.loadAsync(buffer)

    // Look for conversations.json in the ZIP
    let jsonFile = zip.file('conversations.json')
    if (!jsonFile) {
      // Search case-insensitively and in subdirectories
      const matches = zip.file(/conversations\.json$/i)
      if (matches.length > 0) jsonFile = matches[0]
    }

    if (jsonFile) {
      const text = await jsonFile.async('string')
      const data = JSON.parse(text)
      const conversations = Array.isArray(data) ? data : (data.conversations || [data])
      return {
        conversations,
        metadata: { count: conversations.length, format: 'claude_dms' }
      }
    }

    // No conversations.json — try any JSON file in the root
    const jsonFiles = zip.file(/\.json$/i).filter(f => !f.dir)
    for (const jf of jsonFiles) {
      try {
        const text = await jf.async('string')
        const data = JSON.parse(text)
        if (isClaudeConversationData(data)) {
          const conversations = Array.isArray(data) ? data : [data]
          return {
            conversations,
            metadata: { count: conversations.length, format: 'claude_dms' }
          }
        }
      } catch { /* skip non-JSON or non-conversation files */ }
    }

    throw new Error('No conversation data found in ZIP archive')
  } catch (e) {
    if (e.message.includes('No conversation data')) throw e
    // Not a ZIP — try raw JSON
  }

  // Parse as raw JSON
  const text = new TextDecoder().decode(buffer)
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new Error(`Invalid file: not a ZIP archive or valid JSON (${e.message})`)
  }

  const conversations = Array.isArray(data) ? data : (data.conversations || [data])
  if (conversations.length === 0 || !isClaudeConversationData(conversations)) {
    throw new Error('Unrecognized Claude export format')
  }

  return {
    conversations,
    metadata: { count: conversations.length, format: 'claude_json' }
  }
}

/**
 * Detect if data looks like Claude conversation data
 */
function isClaudeConversationData(data) {
  const arr = Array.isArray(data) ? data : [data]
  if (arr.length === 0) return false
  const first = arr[0]
  // Claude conversations have uuid + chat_messages (or name field)
  return !!(first.uuid || first.chat_messages || (first.name && first.created_at))
}

// ============================================================================
// NORMALIZATION
// ============================================================================

/**
 * Normalize a Claude conversation to the unified format
 * @param {object} conversation - Raw Claude conversation
 * @returns {object} { id, title, messages[], metadata }
 */
export function normalizeClaudeConversation(conversation) {
  const messages = []
  const chatMessages = conversation.chat_messages || []

  for (const msg of chatMessages) {
    let content = ''

    // Primary: use 'text' field
    if (msg.text) {
      content = msg.text
    }
    // Fallback: concatenate content blocks
    else if (Array.isArray(msg.content)) {
      content = msg.content
        .map(block => {
          if (typeof block === 'string') return block
          if (block.type === 'text') return block.text || ''
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }

    if (!content.trim()) continue

    // Map sender to role
    const sender = (msg.sender || msg.role || '').toLowerCase()
    let role
    if (sender === 'human' || sender === 'user') {
      role = 'user'
    } else if (sender === 'assistant') {
      role = 'assistant'
    } else {
      continue // skip system/unknown roles
    }

    messages.push({
      role,
      content: content.trim(),
      timestamp: msg.created_at || null,
      model: msg.model || null,
      id: msg.uuid || null
    })
  }

  // Track attachment count in metadata
  const attachmentCount = chatMessages.reduce((sum, msg) => {
    return sum + (msg.attachments?.length || 0) + (msg.files?.length || 0)
  }, 0)

  return {
    id: conversation.uuid || conversation.id || generateId(),
    title: conversation.name || conversation.title || extractTitle(messages),
    messages,
    metadata: {
      model: conversation.model || null,
      createTime: conversation.created_at || null,
      updateTime: conversation.updated_at || null,
      messageCount: messages.length,
      format: 'claude',
      attachmentCount
    }
  }
}

// ============================================================================
// IMPORT
// ============================================================================

/**
 * Import Claude conversations into Quox's memory system
 * @param {File|Blob} file - Claude export file
 * @param {object} options - Import options
 * @returns {Promise<object>} Import results
 */
export async function importClaudeConversations(file, options = {}) {
  if (!hasFeature('hasChatGPTImport')) {
    return {
      success: false, blocked: true,
      reason: 'premium_required',
      upgrade: createUpgradePrompt('chatgptImport')
    }
  }

  const {
    extractMemoriesEnabled = true,
    updateStyle = true,
    minMessageCount = 2,
    deduplicateEnabled = true,
    onProgress = null,
    chunkSize = 50,
    // BRAIN2 HOOK: optional, default-off raw-export path. When true AND the
    // caller supplies an authFetch AND the quox-brain2 plugin is licensed,
    // the normalized conversations are ALSO pushed to Qortex's raw
    // AI-history vault, alongside (not instead of) the memory extraction
    // above. See brain2AiHistoryClient.js for the contract.
    sendRawToQortex = false,
    authFetch = null,
    onBrain2Progress = null
  } = options

  const { conversations, metadata } = await parseClaudeExport(file)

  // Normalize
  const normalized = []
  const errors = []
  for (const conv of conversations) {
    try {
      const norm = normalizeClaudeConversation(conv)
      if (norm.messages.length >= minMessageCount) {
        normalized.push(norm)
      }
    } catch (e) {
      errors.push({ conversation: conv.uuid || conv.id, error: e.message })
    }
  }

  const results = await runImportPipeline(normalized, {
    extractMemoriesEnabled, updateStyle, deduplicateEnabled, onProgress, chunkSize
  }, 'claude')

  results.totalConversations = metadata.count
  results.errors = [...errors, ...results.errors]

  // BRAIN2 HOOK: additive, off by default. Does not touch the
  // extractMemories/runImportPipeline path above in any way.
  if (sendRawToQortex && authFetch && canSendToQortex()) {
    try {
      results.brain2 = await sendConversationsToQortex(normalized, 'claude', {
        authFetch,
        onProgress: onBrain2Progress
      })
    } catch (e) {
      results.brain2 = { error: e.message }
    }
  }

  return results
}

// ============================================================================
// PREVIEW & STATS
// ============================================================================

/**
 * Preview Claude import without saving
 */
export async function previewClaudeImport(file, options = {}) {
  const { limit = 10 } = options
  const { conversations, metadata } = await parseClaudeExport(file)

  const previews = []
  const allMemories = []
  const allTopics = {}

  for (const conv of conversations.slice(0, limit)) {
    try {
      const norm = normalizeClaudeConversation(conv)
      const memories = extractMemories(norm, 'claude')
      const topics = extractTopics(norm)

      previews.push({
        id: norm.id,
        title: norm.title,
        messageCount: norm.messages.length,
        memoriesFound: memories.length,
        topics: Object.keys(topics),
        firstMessage: norm.messages[0]?.content?.substring(0, 100) || null,
        timestamp: norm.metadata.createTime
      })

      allMemories.push(...memories)
      for (const [topic, count] of Object.entries(topics)) {
        allTopics[topic] = (allTopics[topic] || 0) + count
      }
    } catch (e) {
      previews.push({ id: conv.uuid, error: e.message })
    }
  }

  const normalized = conversations.slice(0, Math.min(20, conversations.length))
    .map(c => { try { return normalizeClaudeConversation(c) } catch { return null } })
    .filter(Boolean)
  const styleAnalysis = analyzeImportedStyle(normalized)

  return {
    metadata,
    previews,
    summary: {
      totalConversations: metadata.count,
      previewedCount: previews.length,
      estimatedMemories: limit > 0 ? Math.round((allMemories.length / limit) * metadata.count) : 0,
      topTopics: Object.entries(allTopics).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t),
      detectedStyle: styleAnalysis.style,
      styleConfidence: styleAnalysis.confidence
    },
    sampleMemories: allMemories.slice(0, 10).map(m => ({ type: m.type, content: m.content, confidence: m.confidence }))
  }
}

/**
 * Get statistics about a Claude export
 */
export async function getClaudeExportStats(file) {
  const { conversations, metadata } = await parseClaudeExport(file)

  let totalMessages = 0, userMessages = 0, assistantMessages = 0
  let oldestDate = null, newestDate = null

  for (const conv of conversations) {
    try {
      const norm = normalizeClaudeConversation(conv)
      totalMessages += norm.messages.length
      userMessages += norm.messages.filter(m => m.role === 'user').length
      assistantMessages += norm.messages.filter(m => m.role === 'assistant').length

      if (norm.metadata.createTime) {
        const date = new Date(norm.metadata.createTime)
        if (!oldestDate || date < oldestDate) oldestDate = date
        if (!newestDate || date > newestDate) newestDate = date
      }
    } catch { /* skip malformed conversations */ }
  }

  return {
    format: metadata.format,
    conversationCount: metadata.count,
    totalMessages,
    userMessages,
    assistantMessages,
    dateRange: {
      oldest: oldestDate?.toISOString() || null,
      newest: newestDate?.toISOString() || null,
      spanDays: oldestDate && newestDate ? Math.ceil((newestDate - oldestDate) / (1000 * 60 * 60 * 24)) : null
    },
    models: [],
    averageMessagesPerConversation: metadata.count > 0 ? Math.round(totalMessages / metadata.count) : 0
  }
}
