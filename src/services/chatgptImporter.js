/**
 * ChatGPT Conversation Importer
 *
 * Imports conversation history from ChatGPT exports (conversations.json)
 * and extracts memories, preferences, and knowledge for Quox's memory system.
 *
 * Supported formats:
 * - ChatGPT data export (conversations.json)
 * - Individual conversation JSON files
 *
 * TIERED: ChatGPT Import is a Premium feature
 */

import { hasFeature, createUpgradePrompt } from './memoryTier'
import {
  containsSecrets,
  extractMemories,
  extractTopics,
  createConversationMetadata,
  analyzeImportedStyle,
  deduplicateMemories,
  runImportPipeline,
  generateId,
  extractTitle,
  yieldToUI,
  MEMORY_PATTERNS,
  ASSISTANT_PATTERNS,
  TOPIC_PATTERNS
} from './importShared'
import { sendConversationsToQortex, canSendToQortex } from './brain2AiHistoryClient'

// ============================================================================
// TIER GATING
// ============================================================================

/**
 * Check if ChatGPT Import is available (Premium only)
 * @returns {{ available: boolean, upgrade?: object }}
 */
export function isChatGPTImportAvailable() {
  const available = hasFeature('hasChatGPTImport')
  if (!available) {
    return {
      available: false,
      upgrade: createUpgradePrompt('chatgptImport')
    }
  }
  return { available: true }
}

// ============================================================================
// CHATGPT-SPECIFIC PARSING
// ============================================================================

/**
 * Parse ChatGPT export file
 * @param {string|object} data - JSON string or parsed object
 * @returns {{ conversations: Array, metadata: object }}
 */
export function parseExport(data) {
  let parsed
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data)
    } catch (e) {
      throw new Error(`Invalid JSON: ${e.message}`)
    }
  } else {
    parsed = data
  }

  // Handle different export formats
  let conversations = []

  if (Array.isArray(parsed)) {
    conversations = parsed
  } else if (parsed.conversations) {
    conversations = parsed.conversations
  } else if (parsed.mapping) {
    conversations = [parsed]
  } else {
    throw new Error('Unrecognized export format')
  }

  return {
    conversations,
    metadata: {
      count: conversations.length,
      format: detectFormat(parsed),
      exportedAt: parsed.export_time || parsed.exportedAt || null
    }
  }
}

/**
 * Detect the export format
 */
function detectFormat(data) {
  if (data.model_slug || data.mapping) {
    return 'chatgpt_web'
  }
  if (Array.isArray(data) && data[0]?.messages) {
    return 'chatgpt_api'
  }
  if (data.conversations) {
    return 'chatgpt_export'
  }
  return 'unknown'
}

/**
 * Convert ChatGPT conversation to unified format
 * @param {object} conversation - ChatGPT conversation
 * @returns {object} Unified conversation format
 */
export function normalizeConversation(conversation) {
  const messages = []

  // Handle web export format with mapping
  if (conversation.mapping) {
    const entries = Object.values(conversation.mapping)
      .filter(e => e.message?.content?.parts?.length > 0)
      .sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0))

    for (const entry of entries) {
      const msg = entry.message
      const role = msg.author?.role || 'unknown'
      const content = msg.content?.parts?.join('\n') || ''

      if (content.trim() && (role === 'user' || role === 'assistant')) {
        messages.push({
          role: role === 'user' ? 'user' : 'assistant',
          content: content.trim(),
          timestamp: msg.create_time ? new Date(msg.create_time * 1000).toISOString() : null,
          model: msg.metadata?.model_slug || null
        })
      }
    }
  }
  // Handle API format
  else if (conversation.messages) {
    for (const msg of conversation.messages) {
      if (msg.content?.trim()) {
        messages.push({
          role: msg.role,
          content: msg.content.trim(),
          timestamp: msg.timestamp || null,
          model: conversation.model || null
        })
      }
    }
  }

  return {
    id: conversation.id || conversation.conversation_id || generateId(),
    title: conversation.title || extractTitle(messages),
    messages,
    metadata: {
      model: conversation.model_slug || conversation.model || null,
      createTime: conversation.create_time
        ? new Date(conversation.create_time * 1000).toISOString()
        : null,
      updateTime: conversation.update_time
        ? new Date(conversation.update_time * 1000).toISOString()
        : null,
      messageCount: messages.length
    }
  }
}

// ============================================================================
// MAIN IMPORT
// ============================================================================

/**
 * Import conversations into Quox's memory system
 * TIERED: Premium only
 * @param {string|object} data - Export data
 * @param {object} options - Import options
 * @returns {Promise<object>} Import results
 */
export async function importConversations(data, options = {}) {
  // TIER CHECK: ChatGPT import requires Premium
  if (!hasFeature('hasChatGPTImport')) {
    return {
      success: false,
      blocked: true,
      reason: 'premium_required',
      upgrade: createUpgradePrompt('chatgptImport')
    }
  }

  const {
    extractMemoriesEnabled = true,
    updateStyleProfile: updateStyle = true,
    limit = Infinity,
    minMessageCount = 2,
    deduplicateMemories: dedup = true,
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

  // Parse export
  const { conversations, metadata } = parseExport(data)

  // Normalize conversations
  const toProcess = conversations.slice(0, limit === Infinity ? undefined : limit)
  const normalized = []
  const errors = []

  for (const conv of toProcess) {
    try {
      const norm = normalizeConversation(conv)
      if (norm.messages.length >= minMessageCount) {
        normalized.push(norm)
      }
    } catch (e) {
      errors.push({ conversation: conv.id, error: e.message })
    }
  }

  // Delegate to shared pipeline
  const results = await runImportPipeline(normalized, {
    extractMemoriesEnabled,
    updateStyle,
    deduplicateEnabled: dedup,
    onProgress,
    chunkSize
  }, 'chatgpt')

  results.totalConversations = metadata.count
  results.errors = [...errors, ...results.errors]

  // BRAIN2 HOOK: additive, off by default. Does not touch the
  // extractMemories/runImportPipeline path above in any way.
  if (sendRawToQortex && authFetch && canSendToQortex()) {
    try {
      results.brain2 = await sendConversationsToQortex(normalized, 'chatgpt', {
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
 * Preview what will be imported without saving
 * @param {string|object} data - Export data
 * @param {object} options - Preview options
 * @returns {object} Preview of import
 */
export function previewImport(data, options = {}) {
  const { limit = 10 } = options

  const { conversations, metadata } = parseExport(data)

  const previews = []
  const allMemories = []
  const allTopics = {}

  for (const conv of conversations.slice(0, limit)) {
    try {
      const norm = normalizeConversation(conv)
      const memories = extractMemories(norm, 'chatgpt')
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
      previews.push({ id: conv.id, error: e.message })
    }
  }

  // Analyze style from sample
  const normalized = conversations.slice(0, Math.min(20, conversations.length))
    .map(c => { try { return normalizeConversation(c) } catch { return null } })
    .filter(Boolean)

  const styleAnalysis = analyzeImportedStyle(normalized)

  return {
    metadata,
    previews,
    summary: {
      totalConversations: metadata.count,
      previewedCount: previews.length,
      estimatedMemories: Math.round((allMemories.length / limit) * metadata.count),
      topTopics: Object.entries(allTopics)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([topic]) => topic),
      detectedStyle: styleAnalysis.style,
      styleConfidence: styleAnalysis.confidence
    },
    sampleMemories: allMemories.slice(0, 10).map(m => ({
      type: m.type,
      content: m.content,
      confidence: m.confidence
    }))
  }
}

/**
 * Get statistics about a ChatGPT export
 * @param {string|object} data - Export data
 * @returns {object} Statistics
 */
export function getExportStats(data) {
  const { conversations, metadata } = parseExport(data)

  let totalMessages = 0
  let totalUserMessages = 0
  let totalAssistantMessages = 0
  let oldestDate = null
  let newestDate = null
  const models = {}

  for (const conv of conversations) {
    const norm = normalizeConversation(conv)

    totalMessages += norm.messages.length
    totalUserMessages += norm.messages.filter(m => m.role === 'user').length
    totalAssistantMessages += norm.messages.filter(m => m.role === 'assistant').length

    if (norm.metadata.createTime) {
      const date = new Date(norm.metadata.createTime)
      if (!oldestDate || date < oldestDate) oldestDate = date
      if (!newestDate || date > newestDate) newestDate = date
    }

    if (norm.metadata.model) {
      models[norm.metadata.model] = (models[norm.metadata.model] || 0) + 1
    }
  }

  return {
    format: metadata.format,
    conversationCount: metadata.count,
    totalMessages,
    userMessages: totalUserMessages,
    assistantMessages: totalAssistantMessages,
    dateRange: {
      oldest: oldestDate?.toISOString() || null,
      newest: newestDate?.toISOString() || null,
      spanDays: oldestDate && newestDate
        ? Math.ceil((newestDate - oldestDate) / (1000 * 60 * 60 * 24))
        : null
    },
    models: Object.entries(models)
      .sort((a, b) => b[1] - a[1])
      .map(([model, count]) => ({ model, count })),
    averageMessagesPerConversation: Math.round(totalMessages / metadata.count)
  }
}

// ============================================================================
// RE-EXPORTS (for backward compatibility and test access)
// ============================================================================

export {
  containsSecrets,
  extractMemories,
  extractTopics,
  createConversationMetadata,
  analyzeImportedStyle,
  MEMORY_PATTERNS,
  ASSISTANT_PATTERNS,
  TOPIC_PATTERNS
}

export default {
  isChatGPTImportAvailable,
  parseExport,
  normalizeConversation,
  extractMemories,
  extractTopics,
  createConversationMetadata,
  analyzeImportedStyle,
  importConversations,
  previewImport,
  getExportStats,
  containsSecrets
}
