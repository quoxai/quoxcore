/**
 * Perplexity AI Conversation Importer
 *
 * Imports conversation history from Perplexity AI exports.
 *
 * Supported formats:
 * - Markdown (.md) with YAML frontmatter (native Perplexity export)
 * - JSON (.json) from browser extensions (perplexport, etc.)
 * - ZIP (.zip) containing multiple .md or .json files
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

export function isPerplexityImportAvailable() {
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
 * Parse a Perplexity export file (.md, .json, or .zip)
 * @param {File|Blob} file - The uploaded file
 * @returns {Promise<{ conversations: Array, metadata: object }>}
 */
export async function parsePerplexityExport(file) {
  const buffer = await file.arrayBuffer()
  const text = new TextDecoder().decode(buffer)
  const fileName = file.name || ''

  // Check if it's a Markdown file
  if (fileName.endsWith('.md') || text.trimStart().startsWith('---') || text.trimStart().startsWith('#')) {
    const conv = parsePerplexityMarkdown(text)
    if (conv) {
      return {
        conversations: [conv],
        metadata: { count: 1, format: 'perplexity_markdown' }
      }
    }
  }

  // Try ZIP
  try {
    const zip = await JSZip.loadAsync(buffer)
    const conversations = []
    const files = zip.file(/\.(md|json)$/i).filter(f => !f.dir)

    for (const zf of files) {
      try {
        const content = await zf.async('string')
        if (zf.name.endsWith('.md')) {
          const conv = parsePerplexityMarkdown(content)
          if (conv) conversations.push(conv)
        } else {
          const data = JSON.parse(content)
          const parsed = parsePerplexityJSONData(data)
          conversations.push(...parsed)
        }
      } catch { /* skip unparseable files */ }
    }

    if (conversations.length > 0) {
      return {
        conversations,
        metadata: { count: conversations.length, format: 'perplexity_zip' }
      }
    }
  } catch { /* Not a ZIP */ }

  // Try JSON
  try {
    const data = JSON.parse(text)
    const parsed = parsePerplexityJSONData(data)
    if (parsed.length > 0) {
      return {
        conversations: parsed,
        metadata: { count: parsed.length, format: 'perplexity_json' }
      }
    }
  } catch { /* Not JSON */ }

  throw new Error('Unrecognized Perplexity export format. Expected Markdown, JSON, or ZIP file.')
}

// ============================================================================
// MARKDOWN PARSING
// ============================================================================

/**
 * Parse a single Perplexity Markdown conversation
 * @param {string} text - Full Markdown text
 * @returns {object|null} Parsed conversation or null
 */
export function parsePerplexityMarkdown(text) {
  if (!text || !text.trim()) return null

  // Extract YAML frontmatter
  const frontmatter = extractFrontmatter(text)
  const body = frontmatter._body

  // Parse body into messages by ## headings
  const messages = []
  const citations = []

  // Split on ## headings
  const sections = body.split(/^##\s+/gm)

  for (const section of sections) {
    if (!section.trim()) continue

    const [heading, ...contentLines] = section.split('\n')
    const content = contentLines.join('\n').trim()

    if (!content && !heading) continue

    const headingLower = heading.toLowerCase().trim()

    if (/^user\s*query/i.test(headingLower) || /^question/i.test(headingLower) || /^q\d/i.test(headingLower)) {
      messages.push({ role: 'user', content })
    } else if (/^answer/i.test(headingLower) || /^response/i.test(headingLower) || /^a\d/i.test(headingLower)) {
      // Strip citation markers from content for cleaner memory extraction
      const cleanContent = content.replace(/\[\^\d+\]/g, '').trim()
      messages.push({ role: 'assistant', content: cleanContent })
    } else if (/^sources?$/i.test(headingLower) || /^references?$/i.test(headingLower)) {
      // Parse citation footnotes
      const footnotePattern = /\[\^(\d+)\]:?\s*(https?:\/\/\S+)/g
      let match
      while ((match = footnotePattern.exec(content)) !== null) {
        citations.push({ index: parseInt(match[1]), url: match[2] })
      }
      // Also handle simple URL lists
      const urlPattern = /^[-*]\s*(https?:\/\/\S+)/gm
      while ((match = urlPattern.exec(content)) !== null) {
        citations.push({ url: match[1] })
      }
    } else {
      // Unknown heading — treat as user query if no role indicators
      if (content.length > 10) {
        messages.push({ role: 'user', content: `${heading}\n${content}`.trim() })
      }
    }
  }

  // If no ## headings found, try to parse as simple Q&A with # heading
  if (messages.length === 0) {
    const h1Match = body.match(/^#\s+(.+)/m)
    const remainingContent = body.replace(/^#\s+.+\n?/m, '').trim()
    if (h1Match && remainingContent) {
      messages.push({ role: 'user', content: h1Match[1] })
      messages.push({ role: 'assistant', content: remainingContent })
    } else if (body.trim().length > 20) {
      // Last resort: treat entire body as a single assistant response
      messages.push({ role: 'assistant', content: body.trim() })
    }
  }

  if (messages.length === 0) return null

  return {
    _raw: 'markdown',
    title: frontmatter.title || extractTitle(messages),
    url: frontmatter.url || null,
    date: frontmatter.date || null,
    messages,
    citations
  }
}

/**
 * Extract YAML frontmatter from Markdown
 * @param {string} text - Full Markdown text
 * @returns {object} Parsed frontmatter with _body property
 */
function extractFrontmatter(text) {
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!fmMatch) {
    return { _body: text }
  }

  const result = { _body: fmMatch[2] }
  // Simple key-value YAML parser
  for (const line of fmMatch[1].split('\n')) {
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.+)$/)
    if (kvMatch) {
      result[kvMatch[1].toLowerCase()] = kvMatch[2].trim().replace(/^['"]|['"]$/g, '')
    }
  }
  return result
}

// ============================================================================
// JSON PARSING
// ============================================================================

/**
 * Parse Perplexity JSON data (from browser extensions)
 * @param {object|Array} data - Parsed JSON
 * @returns {Array} Array of parsed conversation objects
 */
function parsePerplexityJSONData(data) {
  // Single conversation with messages array
  if (data.messages && Array.isArray(data.messages)) {
    return [parsePerplexitySingleJSON(data)]
  }

  // Array of conversations
  if (Array.isArray(data)) {
    return data.map(item => {
      if (item.messages) return parsePerplexitySingleJSON(item)
      if (item.query || item.answer) return parsePerplexityQAPair(item)
      return null
    }).filter(Boolean)
  }

  // Single Q&A pair
  if (data.query || data.answer) {
    return [parsePerplexityQAPair(data)]
  }

  return []
}

/**
 * Parse a single Perplexity JSON conversation with messages array
 */
function parsePerplexitySingleJSON(data) {
  const messages = []
  const allCitations = []

  for (const msg of (data.messages || [])) {
    if (msg.query) {
      messages.push({ role: 'user', content: msg.query })
    }
    if (msg.answer) {
      messages.push({ role: 'assistant', content: msg.answer })
    }
    if (msg.citations) {
      allCitations.push(...msg.citations)
    }
  }

  return {
    _raw: 'json',
    title: data.title || extractTitle(messages),
    url: data.url || null,
    date: data.date || data.created_at || null,
    messages,
    citations: allCitations,
    followUpQueries: data.messages?.flatMap(m => m.follow_up_queries || []) || []
  }
}

/**
 * Parse a single Q&A pair
 */
function parsePerplexityQAPair(data) {
  const messages = []
  if (data.query) messages.push({ role: 'user', content: data.query })
  if (data.answer) messages.push({ role: 'assistant', content: data.answer })

  return {
    _raw: 'json',
    title: data.title || extractTitle(messages),
    url: data.url || null,
    date: data.date || null,
    messages,
    citations: data.citations || [],
    followUpQueries: data.follow_up_queries || []
  }
}

// ============================================================================
// NORMALIZATION
// ============================================================================

/**
 * Normalize a parsed Perplexity conversation to the unified format
 * @param {object} conversation - Parsed Perplexity conversation
 * @returns {object} { id, title, messages[], metadata }
 */
export function normalizePerplexityConversation(conversation) {
  const messages = (conversation.messages || []).map(m => ({
    role: m.role,
    content: m.content?.trim() || '',
    timestamp: conversation.date || null,
    model: null
  })).filter(m => m.content)

  return {
    id: generateId(),
    title: conversation.title || extractTitle(messages),
    messages,
    metadata: {
      model: null,
      createTime: conversation.date || null,
      updateTime: null,
      messageCount: messages.length,
      format: `perplexity_${conversation._raw || 'unknown'}`,
      url: conversation.url || null,
      citationCount: conversation.citations?.length || 0,
      followUpQueries: conversation.followUpQueries || []
    }
  }
}

// ============================================================================
// IMPORT
// ============================================================================

/**
 * Import Perplexity conversations
 */
export async function importPerplexityConversations(file, options = {}) {
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
    minMessageCount = 1, // Perplexity often has single Q&A pairs
    deduplicateEnabled = true,
    onProgress = null,
    chunkSize = 50,
    // BRAIN2 HOOK: optional, default-off raw-export path (additive to extraction).
    sendRawToQortex = false,
    authFetch = null,
    onBrain2Progress = null
  } = options

  const { conversations, metadata } = await parsePerplexityExport(file)

  const normalized = []
  const errors = []
  for (const conv of conversations) {
    try {
      const norm = normalizePerplexityConversation(conv)
      if (norm.messages.length >= minMessageCount) {
        normalized.push(norm)
      }
    } catch (e) {
      errors.push({ conversation: conv.title || 'unknown', error: e.message })
    }
  }

  const results = await runImportPipeline(normalized, {
    extractMemoriesEnabled, updateStyle, deduplicateEnabled, onProgress, chunkSize
  }, 'perplexity')

  results.totalConversations = metadata.count
  results.errors = [...errors, ...results.errors]

  // BRAIN2 HOOK: additive, off by default. Does not touch the extraction path above.
  if (sendRawToQortex && authFetch && canSendToQortex()) {
    try {
      results.brain2 = await sendConversationsToQortex(normalized, 'perplexity', {
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

export async function previewPerplexityImport(file, options = {}) {
  const { limit = 10 } = options
  const { conversations, metadata } = await parsePerplexityExport(file)

  const previews = []
  const allMemories = []
  const allTopics = {}

  for (const conv of conversations.slice(0, limit)) {
    try {
      const norm = normalizePerplexityConversation(conv)
      const memories = extractMemories(norm, 'perplexity')
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
    .map(c => { try { return normalizePerplexityConversation(c) } catch { return null } })
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

export async function getPerplexityExportStats(file) {
  const { conversations, metadata } = await parsePerplexityExport(file)

  let totalMessages = 0, userMessages = 0, assistantMessages = 0
  let oldestDate = null, newestDate = null
  let totalCitations = 0

  for (const conv of conversations) {
    try {
      const norm = normalizePerplexityConversation(conv)
      totalMessages += norm.messages.length
      userMessages += norm.messages.filter(m => m.role === 'user').length
      assistantMessages += norm.messages.filter(m => m.role === 'assistant').length
      totalCitations += norm.metadata.citationCount || 0

      if (norm.metadata.createTime) {
        const date = new Date(norm.metadata.createTime)
        if (!oldestDate || date < oldestDate) oldestDate = date
        if (!newestDate || date > newestDate) newestDate = date
      }
    } catch { /* skip malformed */ }
  }

  return {
    format: metadata.format,
    conversationCount: metadata.count,
    totalMessages,
    userMessages,
    assistantMessages,
    totalCitations,
    dateRange: {
      oldest: oldestDate?.toISOString() || null,
      newest: newestDate?.toISOString() || null,
      spanDays: oldestDate && newestDate ? Math.ceil((newestDate - oldestDate) / (1000 * 60 * 60 * 24)) : null
    },
    models: [],
    averageMessagesPerConversation: metadata.count > 0 ? Math.round(totalMessages / metadata.count) : 0
  }
}
