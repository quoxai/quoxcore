/**
 * Google Gemini Conversation Importer
 *
 * Imports conversation history from Google Gemini exports.
 *
 * Supported formats:
 * - Google Takeout ZIP (MyActivity.json or Conversations.json)
 * - AI Studio JSON (chunkedPrompt format)
 * - Direct JSON array of conversations
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

export function isGeminiImportAvailable() {
  const available = hasFeature('hasChatGPTImport')
  if (!available) {
    return { available: false, upgrade: createUpgradePrompt('chatgptImport') }
  }
  return { available: true }
}

// ============================================================================
// FORMAT DETECTION
// ============================================================================

/**
 * Detect if data is a Gemini Takeout activity entry
 */
function isTakeoutActivity(item) {
  return !!(item.title || item.time || item.products || item.details)
}

/**
 * Detect if data is an AI Studio conversation
 */
function isAIStudioFormat(data) {
  return !!(data.chunkedPrompt || data.runSettings)
}

/**
 * Detect if data looks like Gemini conversation data
 */
function isGeminiConversationData(data) {
  if (Array.isArray(data)) {
    return data.length > 0 && (isTakeoutActivity(data[0]) || isAIStudioFormat(data[0]))
  }
  return isAIStudioFormat(data) || isTakeoutActivity(data)
}

// ============================================================================
// PARSING
// ============================================================================

/**
 * Parse a Gemini export file (ZIP or JSON)
 * @param {File|Blob} file - The uploaded file
 * @returns {Promise<{ conversations: Array, metadata: object }>}
 */
export async function parseGeminiExport(file) {
  const buffer = await file.arrayBuffer()

  // Try ZIP first (Google Takeout)
  try {
    const zip = await JSZip.loadAsync(buffer)
    const conversations = []

    // Search all JSON files recursively
    const jsonFiles = zip.file(/\.json$/i).filter(f => !f.dir)

    for (const jf of jsonFiles) {
      try {
        const text = await jf.async('string')
        const data = JSON.parse(text)

        if (Array.isArray(data)) {
          // Array of activity entries (MyActivity.json)
          const geminiEntries = data.filter(item => isTakeoutActivity(item))
          if (geminiEntries.length > 0) {
            conversations.push(...geminiEntries.map(entry => ({ ...entry, _format: 'takeout' })))
          }
        } else if (isAIStudioFormat(data)) {
          conversations.push({ ...data, _format: 'ai_studio', _filename: jf.name })
        }
      } catch { /* skip non-JSON files */ }
    }

    if (conversations.length > 0) {
      return {
        conversations,
        metadata: { count: conversations.length, format: 'gemini_takeout_zip' }
      }
    }
    // If no conversations found in ZIP, fall through to try raw JSON
  } catch { /* Not a ZIP */ }

  // Parse as raw JSON
  const text = new TextDecoder().decode(buffer)
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new Error(`Invalid file: not a ZIP archive or valid JSON (${e.message})`)
  }

  // Handle array of activities (Takeout export)
  if (Array.isArray(data)) {
    const activities = data.filter(item => isTakeoutActivity(item))
    if (activities.length > 0) {
      return {
        conversations: activities.map(a => ({ ...a, _format: 'takeout' })),
        metadata: { count: activities.length, format: 'gemini_takeout' }
      }
    }
    // Array of AI Studio conversations
    const studios = data.filter(item => isAIStudioFormat(item))
    if (studios.length > 0) {
      return {
        conversations: studios.map(s => ({ ...s, _format: 'ai_studio' })),
        metadata: { count: studios.length, format: 'gemini_ai_studio' }
      }
    }
  }

  // Single AI Studio conversation
  if (isAIStudioFormat(data)) {
    return {
      conversations: [{ ...data, _format: 'ai_studio' }],
      metadata: { count: 1, format: 'gemini_ai_studio' }
    }
  }

  throw new Error('Unrecognized Gemini export format. Expected Google Takeout JSON or AI Studio JSON.')
}

// ============================================================================
// NORMALIZATION
// ============================================================================

/**
 * Normalize a Gemini conversation to the unified format
 * @param {object} conversation - Raw Gemini conversation (Takeout or AI Studio)
 * @returns {object} { id, title, messages[], metadata }
 */
export function normalizeGeminiConversation(conversation) {
  const format = conversation._format

  if (format === 'ai_studio') {
    return normalizeAIStudio(conversation)
  }
  return normalizeTakeout(conversation)
}

/**
 * Normalize AI Studio format (chunkedPrompt)
 */
function normalizeAIStudio(conversation) {
  const messages = []
  const chunks = conversation.chunkedPrompt?.chunks || []
  const model = conversation.runSettings?.model || null

  for (const chunk of chunks) {
    // Skip internal reasoning (thought) chunks
    if (chunk.isThought) continue

    const content = chunk.text?.trim()
    if (!content) continue

    const role = chunk.role === 'model' ? 'assistant' : (chunk.role || 'user')
    if (role !== 'user' && role !== 'assistant') continue

    messages.push({
      role,
      content,
      timestamp: null,
      model: role === 'assistant' ? model : null
    })
  }

  // Extract title from system instruction or first user message
  const systemText = conversation.systemInstruction?.parts?.[0]?.text
  const title = conversation._filename
    ? conversation._filename.replace(/\.json$/i, '')
    : (systemText?.substring(0, 50) || extractTitle(messages))

  return {
    id: generateId(),
    title,
    messages,
    metadata: {
      model: model?.replace('models/', '') || null,
      createTime: null,
      updateTime: null,
      messageCount: messages.length,
      format: 'gemini_ai_studio',
      temperature: conversation.runSettings?.temperature || null,
      thoughtChunksFiltered: chunks.filter(c => c.isThought).length
    }
  }
}

/**
 * Normalize Google Takeout activity format
 */
function normalizeTakeout(conversation) {
  const messages = []

  // Takeout entries have a "details" array or direct content
  // Each entry is typically a single Q&A pair
  if (conversation.details) {
    for (const detail of conversation.details) {
      if (detail.name === 'Prompt' || detail.name === 'Query') {
        messages.push({
          role: 'user',
          content: detail.value?.trim() || '',
          timestamp: conversation.time || null,
          model: null
        })
      } else if (detail.name === 'Response') {
        messages.push({
          role: 'assistant',
          content: detail.value?.trim() || '',
          timestamp: conversation.time || null,
          model: null
        })
      }
    }
  }

  // Some Takeout formats have a "subtitles" field
  if (messages.length === 0 && conversation.subtitles) {
    for (const sub of conversation.subtitles) {
      if (sub.name) {
        messages.push({
          role: 'user',
          content: sub.name?.trim() || '',
          timestamp: conversation.time || null,
          model: null
        })
      }
    }
  }

  // If we still have no messages but have a title, use it
  if (messages.length === 0 && conversation.title && conversation.title !== 'Gemini') {
    messages.push({
      role: 'user',
      content: conversation.title,
      timestamp: conversation.time || null,
      model: null
    })
  }

  return {
    id: generateId(),
    title: conversation.title || extractTitle(messages),
    messages: messages.filter(m => m.content),
    metadata: {
      model: null,
      createTime: conversation.time || null,
      updateTime: null,
      messageCount: messages.length,
      format: 'gemini_takeout',
      products: conversation.products || []
    }
  }
}

// ============================================================================
// IMPORT
// ============================================================================

/**
 * Import Gemini conversations
 */
export async function importGeminiConversations(file, options = {}) {
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
    // BRAIN2 HOOK: optional, default-off raw-export path (additive to extraction).
    sendRawToQortex = false,
    authFetch = null,
    onBrain2Progress = null
  } = options

  const { conversations, metadata } = await parseGeminiExport(file)

  const normalized = []
  const errors = []
  for (const conv of conversations) {
    try {
      const norm = normalizeGeminiConversation(conv)
      if (norm.messages.length >= minMessageCount) {
        normalized.push(norm)
      }
    } catch (e) {
      errors.push({ conversation: conv.title || 'unknown', error: e.message })
    }
  }

  const results = await runImportPipeline(normalized, {
    extractMemoriesEnabled, updateStyle, deduplicateEnabled, onProgress, chunkSize
  }, 'gemini')

  results.totalConversations = metadata.count
  results.errors = [...errors, ...results.errors]

  // BRAIN2 HOOK: additive, off by default. Does not touch the extraction path above.
  if (sendRawToQortex && authFetch && canSendToQortex()) {
    try {
      results.brain2 = await sendConversationsToQortex(normalized, 'gemini', {
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

export async function previewGeminiImport(file, options = {}) {
  const { limit = 10 } = options
  const { conversations, metadata } = await parseGeminiExport(file)

  const previews = []
  const allMemories = []
  const allTopics = {}

  for (const conv of conversations.slice(0, limit)) {
    try {
      const norm = normalizeGeminiConversation(conv)
      const memories = extractMemories(norm, 'gemini')
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
      previews.push({ id: conv.title, error: e.message })
    }
  }

  const normalized = conversations.slice(0, Math.min(20, conversations.length))
    .map(c => { try { return normalizeGeminiConversation(c) } catch { return null } })
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

export async function getGeminiExportStats(file) {
  const { conversations, metadata } = await parseGeminiExport(file)

  let totalMessages = 0, userMessages = 0, assistantMessages = 0
  let oldestDate = null, newestDate = null
  const models = {}

  for (const conv of conversations) {
    try {
      const norm = normalizeGeminiConversation(conv)
      totalMessages += norm.messages.length
      userMessages += norm.messages.filter(m => m.role === 'user').length
      assistantMessages += norm.messages.filter(m => m.role === 'assistant').length

      if (norm.metadata.createTime) {
        const date = new Date(norm.metadata.createTime)
        if (!oldestDate || date < oldestDate) oldestDate = date
        if (!newestDate || date > newestDate) newestDate = date
      }
      if (norm.metadata.model) {
        models[norm.metadata.model] = (models[norm.metadata.model] || 0) + 1
      }
    } catch { /* skip malformed */ }
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
    models: Object.entries(models).sort((a, b) => b[1] - a[1]).map(([model, count]) => ({ model, count })),
    averageMessagesPerConversation: metadata.count > 0 ? Math.round(totalMessages / metadata.count) : 0
  }
}
