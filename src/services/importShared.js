/**
 * Shared Conversation Import Utilities
 *
 * Platform-agnostic extraction, deduplication, and persistence pipeline.
 * Used by chatgptImporter, claudeImporter, geminiImporter, perplexityImporter.
 */

import { analyzeMessageStyle, updateStyleProfile } from './styleEngine'
import { getMemoryClient } from './memoryClient'

// ============================================================================
// SECRET DETECTION
// ============================================================================

export const SECRET_PATTERNS = {
  api_key: /\b(api[_-]?key|apikey|api[_-]?token|access[_-]?token|bearer)\s*[=:]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
  aws_key: /\b(AKIA[0-9A-Z]{16})\b/g,
  github_token: /\b(gh[pousr]_[A-Za-z0-9_]{36,})\b/g,
  generic_secret: /\b(secret|private[_-]?key|auth[_-]?token)\s*[=:]\s*['"]?([^\s'"]{8,})['"]?/gi,
  password: /\b(password|passwd|pwd)\s*[=:]\s*['"]?([^\s'"]{4,})['"]?/gi,
  connection_string: /\b(mongodb|postgres|mysql|redis):\/\/[^\s]+:[^\s@]+@/gi,
  private_key: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/gi,
}

export function containsSecrets(content) {
  if (!content || typeof content !== 'string') return false
  for (const pattern of Object.values(SECRET_PATTERNS)) {
    if (pattern.test(content)) {
      pattern.lastIndex = 0
      return true
    }
  }
  return false
}

// ============================================================================
// PATTERN CONSTANTS
// ============================================================================

// Sentence-end anchor: captures until punctuation or newline
const SE = /[.!?\n]/.source
const TILL_SE = `([^.!?\\n]{4,})`

// Memory extraction patterns — user messages
export const MEMORY_PATTERNS = {
  preference: {
    patterns: [
      new RegExp(`i\\s+(?:prefer|like|want|love|enjoy)\\s+${TILL_SE}`, 'gi'),
      new RegExp(`(?:always|usually|typically)\\s+(?:use|do|prefer)\\s+${TILL_SE}`, 'gi'),
      new RegExp(`my\\s+(?:favorite|preferred|usual)\\s+(?:way|method|approach)\\s+(?:is|to)\\s+${TILL_SE}`, 'gi')
    ],
    type: 'preference',
    confidence: 0.7
  },
  fact: {
    patterns: [
      new RegExp(`i\\s+(?:am|work\\s+as|work\\s+at|live\\s+in|have)\\s+${TILL_SE}`, 'gi'),
      new RegExp(`my\\s+(?:name|job|role|company|team)\\s+is\\s+${TILL_SE}`, 'gi'),
      new RegExp(`i(?:'ve|\\s+have)\\s+been\\s+(?:working\\s+on|doing|learning)\\s+${TILL_SE}`, 'gi')
    ],
    type: 'fact',
    confidence: 0.75
  },
  decision: {
    patterns: [
      new RegExp(`(?:decided|chose|going)\\s+(?:to\\s+use|with)\\s+${TILL_SE}`, 'gi'),
      new RegExp(`we(?:'re|\\s+are)\\s+using\\s+${TILL_SE}`, 'gi'),
      new RegExp(`(?:switched|migrated|moved)\\s+(?:to|from)\\s+${TILL_SE}`, 'gi')
    ],
    type: 'decision',
    confidence: 0.65
  },
  project: {
    patterns: [
      new RegExp(`(?:working\\s+on|building|developing)\\s+${TILL_SE}`, 'gi'),
      new RegExp(`(?:project|app|application|system)\\s+(?:called|named)\\s+${TILL_SE}`, 'gi')
    ],
    type: 'project',
    confidence: 0.7
  },
  constraint: {
    patterns: [
      new RegExp(`(?:must|need\\s+to|have\\s+to|should)\\s+${TILL_SE}`, 'gi'),
      new RegExp(`(?:can't|cannot|shouldn't|don't)\\s+${TILL_SE}`, 'gi'),
      new RegExp(`(?:requirement|constraint)\\s+(?:is|that)\\s+${TILL_SE}`, 'gi')
    ],
    type: 'constraint',
    confidence: 0.6
  },
  remember: {
    patterns: [
      new RegExp(`remember\\s+(?:that|this)?:?\\s*${TILL_SE}`, 'gi'),
      new RegExp(`(?:note|save|store)\\s+(?:that|this)?:?\\s*${TILL_SE}`, 'gi'),
      new RegExp(`keep\\s+in\\s+mind:?\\s*${TILL_SE}`, 'gi')
    ],
    type: 'fact',
    confidence: 0.95
  },
  knowledge: {
    patterns: [
      /(\w[\w\s]{2,30})\s+(?:is\s+used\s+for|is\s+responsible\s+for|handles)\s+[^.!?\n]{4,}/gi,
      /(\w[\w\s]{2,30})\s+(?:works\s+by|connects\s+to|depends\s+on)\s+[^.!?\n]{4,}/gi,
      /(?:the\s+(?:default|standard|correct)\s+(?:way|approach|method)\s+is)\s+[^.!?\n]{4,}/gi
    ],
    type: 'fact',
    confidence: 0.65,
    extractFull: true
  },
  troubleshooting: {
    patterns: [
      new RegExp(`(?:the\\s+)?(?:fix|solution|answer|workaround)\\s+(?:was|is)\\s+${TILL_SE}`, 'gi'),
      new RegExp(`(?:the\\s+)?(?:issue|problem|bug|error)\\s+(?:was|is)\\s+(?:caused\\s+by\\s+)?${TILL_SE}`, 'gi'),
      new RegExp(`(?:solved|fixed|resolved)\\s+(?:it\\s+)?by\\s+${TILL_SE}`, 'gi')
    ],
    type: 'fact',
    confidence: 0.7
  },
  architecture: {
    patterns: [
      /(?:we|i)\s+use\s+(\w[\w\s\-]{2,40})\s+for\s+[^.!?\n]{4,}/gi,
      /(?:our|the)\s+(?:stack|setup|infrastructure|architecture)\s+(?:uses|includes|has)\s+[^.!?\n]{4,}/gi,
      /(?:running|hosting|deploying)\s+(?:on|with|via)\s+[^.!?\n]{4,}/gi
    ],
    type: 'decision',
    confidence: 0.65,
    extractFull: true
  },
  opinion: {
    patterns: [
      /(\w[\w\s]{2,30})\s+is\s+(?:better|worse|faster|slower|easier|harder)\s+than\s+[^.!?\n]{4,}/gi,
      /(?:avoid|don't\s+use|stay\s+away\s+from)\s+(\w[\w\s]{2,30})\s+because\s+[^.!?\n]{4,}/gi,
      new RegExp(`i\\s+(?:recommend|suggest)\\s+${TILL_SE}`, 'gi')
    ],
    type: 'preference',
    confidence: 0.65,
    extractFull: true
  }
}

// Assistant-side extraction patterns
export const ASSISTANT_PATTERNS = {
  solution: {
    patterns: [
      new RegExp(`(?:the\\s+solution\\s+is|to\\s+fix\\s+this|here'?s?\\s+(?:the|a)\\s+fix)\\s*:?\\s*${TILL_SE}`, 'gi'),
      new RegExp(`(?:you\\s+(?:should|can|need\\s+to))\\s+${TILL_SE}`, 'gi')
    ],
    type: 'fact',
    confidence: 0.6
  },
  recommendation: {
    patterns: [
      new RegExp(`i(?:'d|\\s+would)\\s+recommend\\s+${TILL_SE}`, 'gi'),
      new RegExp(`(?:the\\s+best\\s+(?:approach|practice|way)\\s+is)\\s+${TILL_SE}`, 'gi')
    ],
    type: 'decision',
    confidence: 0.55
  }
}

// Topic detection patterns
export const TOPIC_PATTERNS = [
  { pattern: /(?:docker|container|kubernetes|k8s)/gi, topic: 'containers' },
  { pattern: /(?:python|javascript|typescript|golang|rust)/gi, topic: 'programming' },
  { pattern: /(?:react|vue|angular|svelte)/gi, topic: 'frontend' },
  { pattern: /(?:api|rest|graphql|grpc)/gi, topic: 'api' },
  { pattern: /(?:database|sql|postgres|mysql|mongodb|redis)/gi, topic: 'database' },
  { pattern: /(?:linux|ubuntu|debian|centos)/gi, topic: 'linux' },
  { pattern: /(?:security|auth|authentication|encryption)/gi, topic: 'security' },
  { pattern: /(?:network|dns|vpn|firewall)/gi, topic: 'networking' },
  { pattern: /(?:proxmox|vmware|hypervisor|vm)/gi, topic: 'virtualization' },
  { pattern: /(?:ci\/cd|deploy|pipeline|github\s*actions)/gi, topic: 'devops' },
  { pattern: /(?:ai|machine\s*learning|llm|gpt|claude)/gi, topic: 'ai' }
]

// Platform display labels
const PLATFORM_LABELS = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  quox: 'QuoxCORE'
}

// ============================================================================
// PATTERN MATCHING ENGINE
// ============================================================================

/**
 * Run pattern group against content and collect matches
 * @param {object} patternGroup - { patterns, type, confidence, extractFull? }
 * @param {string} content - Message text
 * @param {Set} seen - Dedup set
 * @param {object} context - Conversation context for memory
 * @param {string} platform - Source platform (e.g. 'chatgpt', 'claude')
 * @returns {Array} Extracted memories
 */
export function runPatterns(patternGroup, content, seen, context, platform = 'import') {
  const memories = []

  for (const pattern of patternGroup.patterns) {
    pattern.lastIndex = 0
    let match

    while ((match = pattern.exec(content)) !== null) {
      let extracted
      if (patternGroup.extractFull) {
        extracted = match[0]?.trim()
      } else {
        extracted = match[1]?.trim()
      }

      if (!extracted || extracted.length < 15) continue
      if (extracted.length > 200) extracted = extracted.substring(0, 200)

      if (containsSecrets(extracted) || containsSecrets(content)) continue

      const key = `${patternGroup.type}:${extracted.toLowerCase().substring(0, 100)}`
      if (seen.has(key)) continue
      seen.add(key)

      memories.push({
        content: extracted,
        type: patternGroup.type,
        source: `${platform}_import`,
        confidence: patternGroup.confidence,
        context,
        importedAt: new Date().toISOString()
      })
    }
  }

  return memories
}

// ============================================================================
// EXTRACTION FUNCTIONS
// ============================================================================

/**
 * Extract memories from a normalized conversation
 * @param {object} conversation - Normalized conversation { id, title, messages[], metadata }
 * @param {string} platform - Source platform
 * @returns {Array} Extracted memories
 */
export function extractMemories(conversation, platform = 'import') {
  const memories = []
  const seen = new Set()

  for (const msg of conversation.messages) {
    const content = msg.content
    const context = {
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      timestamp: msg.timestamp,
      fullMessage: content.substring(0, 200)
    }

    const patterns = msg.role === 'user' ? MEMORY_PATTERNS : ASSISTANT_PATTERNS

    for (const config of Object.values(patterns)) {
      memories.push(...runPatterns(config, content, seen, context, platform))
    }
  }

  return memories
}

/**
 * Extract topics from a normalized conversation
 * @param {object} conversation - Normalized conversation
 * @returns {object} Topic frequency map
 */
export function extractTopics(conversation) {
  const topics = {}

  for (const msg of conversation.messages) {
    const content = msg.content.toLowerCase()

    for (const { pattern, topic } of TOPIC_PATTERNS) {
      pattern.lastIndex = 0
      const matches = content.match(pattern)
      if (matches) {
        topics[topic] = (topics[topic] || 0) + matches.length
      }
    }
  }

  return topics
}

/**
 * Create a conversation metadata memory (searchable summary)
 * @param {object} conversation - Normalized conversation
 * @param {object} topics - Extracted topics
 * @param {string} platform - Source platform
 * @returns {object|null} Metadata memory or null
 */
export function createConversationMetadata(conversation, topics, platform = 'chatgpt') {
  if (conversation.messages.length < 2) return null

  const topicList = Object.keys(topics)
  const title = conversation.title || 'Untitled'
  const label = PLATFORM_LABELS[platform] || platform
  const date = conversation.metadata.createTime
    ? new Date(conversation.metadata.createTime).toLocaleDateString()
    : 'unknown date'
  const model = conversation.metadata.model || 'unknown'
  const msgCount = conversation.messages.length

  const content = `${label} conversation: "${title}" (${date}, ${msgCount} messages, model: ${model})` +
    (topicList.length > 0 ? `. Topics: ${topicList.join(', ')}` : '')

  return {
    content,
    type: 'fact',
    source: `${platform}_import`,
    confidence: 0.8,
    tags: [platform, 'conversation_metadata', ...topicList],
    source_conversation_id: conversation.id,
    context: {
      conversationId: conversation.id,
      conversationTitle: title,
      timestamp: conversation.metadata.createTime
    },
    importedAt: new Date().toISOString()
  }
}

/**
 * Analyze user style from imported conversations
 * @param {Array} conversations - Normalized conversations
 * @returns {object} Style analysis
 */
export function analyzeImportedStyle(conversations) {
  const allUserMessages = conversations.flatMap(conv =>
    conv.messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
  )

  const sampleSize = Math.min(100, allUserMessages.length)
  const sample = allUserMessages.slice(0, sampleSize)

  const aggregatedStyle = {
    formality: 0,
    verbosity: 0,
    technicality: 0,
    emotionality: 0,
    directness: 0,
    questionStyle: 0
  }

  let count = 0
  for (const msg of sample) {
    const analysis = analyzeMessageStyle(msg)
    if (analysis.confidence > 0.3) {
      for (const dim of Object.keys(aggregatedStyle)) {
        aggregatedStyle[dim] += analysis.signals[dim] || 0.5
      }
      count++
    }
  }

  if (count > 0) {
    for (const dim of Object.keys(aggregatedStyle)) {
      aggregatedStyle[dim] /= count
    }
  }

  return {
    style: aggregatedStyle,
    messageCount: allUserMessages.length,
    sampleSize: count,
    confidence: Math.min(1, count / 50)
  }
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

/**
 * Deduplicate memories by type:content[:100]
 * @param {Array} memories - Array of memory objects
 * @returns {Array} Deduplicated memories
 */
export function deduplicateMemories(memories) {
  const seen = new Set()
  return memories.filter(m => {
    const key = `${m.type}:${m.content.toLowerCase().substring(0, 100)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Yield to the event loop to keep the UI responsive
 */
export function yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Generate a unique import ID
 */
export function generateId() {
  return 'import_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 7)
}

/**
 * Extract a title from the first user message
 */
export function extractTitle(messages) {
  const firstUserMsg = messages.find(m => m.role === 'user')
  if (firstUserMsg) {
    return firstUserMsg.content.substring(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '')
  }
  return 'Untitled Conversation'
}

// ============================================================================
// IMPORT PIPELINE
// ============================================================================

/**
 * Run the full import pipeline on already-normalized conversations.
 * Extracts memories, deduplicates, saves to server, archives conversations.
 *
 * @param {Array} normalized - Normalized conversations [{ id, title, messages[], metadata }]
 * @param {object} options - Import options
 * @param {string} platform - Source platform ('chatgpt', 'claude', 'gemini', 'perplexity')
 * @returns {Promise<object>} Import results
 */
export async function runImportPipeline(normalized, options = {}, platform = 'chatgpt') {
  const {
    extractMemoriesEnabled = true,
    updateStyle = true,
    deduplicateEnabled = true,
    onProgress = null,
    chunkSize = 50
  } = options

  const memoryClient = getMemoryClient()

  const results = {
    conversationsProcessed: normalized.length,
    totalConversations: normalized.length,
    memoriesExtracted: 0,
    memoriesSaved: 0,
    metadataCreated: 0,
    topicsFound: {},
    styleUpdated: false,
    conversationsArchived: 0,
    conversationsSkipped: 0,
    errors: []
  }

  // Phase 1: Extract memories and topics
  const allMemories = []
  const allTopics = {}

  for (let i = 0; i < normalized.length; i += chunkSize) {
    const chunk = normalized.slice(i, i + chunkSize)

    for (const conv of chunk) {
      if (extractMemoriesEnabled) {
        const memories = extractMemories(conv, platform)
        allMemories.push(...memories)
      }

      const topics = extractTopics(conv)
      for (const [topic, count] of Object.entries(topics)) {
        allTopics[topic] = (allTopics[topic] || 0) + count
      }

      if (extractMemoriesEnabled) {
        const metaMem = createConversationMetadata(conv, topics, platform)
        if (metaMem) {
          allMemories.push(metaMem)
          results.metadataCreated++
        }
      }
    }

    if (onProgress) {
      onProgress({
        current: Math.min(i + chunkSize, normalized.length),
        total: normalized.length,
        status: `Extracted from ${Math.min(i + chunkSize, normalized.length)}/${normalized.length} conversations (${allMemories.length} memories found)`
      })
    }

    await yieldToUI()
  }

  results.memoriesExtracted = allMemories.length
  results.topicsFound = allTopics

  // Phase 2: Deduplicate and save memories
  let memoriesToSave = deduplicateEnabled ? deduplicateMemories(allMemories) : allMemories

  if (memoriesToSave.length > 0) {
    const BATCH_SIZE = 100
    for (let i = 0; i < memoriesToSave.length; i += BATCH_SIZE) {
      const batch = memoriesToSave.slice(i, i + BATCH_SIZE)

      try {
        const batchResult = await memoryClient.saveBatch(batch.map(m => ({
          type: m.type,
          content: m.content,
          importance: 'medium',
          tags: m.tags || [platform, 'import'],
          provenance: `${platform}_import`,
          source_conversation_id: m.source_conversation_id || m.context?.conversationId || null
        })))

        results.memoriesSaved += batchResult.memories_created || batch.length
        if (batchResult.errors?.length > 0) {
          results.errors.push(...batchResult.errors)
        }
      } catch (e) {
        results.errors.push({ batch: `${i}-${i + batch.length}`, error: e.message })
      }

      if (onProgress) {
        onProgress({
          current: normalized.length,
          total: normalized.length,
          status: `Saved ${Math.min(i + BATCH_SIZE, memoriesToSave.length)}/${memoriesToSave.length} memories to server`
        })
      }

      await yieldToUI()
    }
  }

  // Phase 3: Archive full conversations
  const CONV_BATCH_SIZE = 50
  for (let i = 0; i < normalized.length; i += CONV_BATCH_SIZE) {
    const chunk = normalized.slice(i, i + CONV_BATCH_SIZE)

    const archiveBatch = chunk.map(conv => {
      const timestamps = conv.messages
        .map(m => m.timestamp)
        .filter(Boolean)
        .sort()

      return {
        conversation_id: conv.id,
        platform,
        title: conv.title || 'Untitled',
        message_count: conv.messages.length,
        topics: Object.keys(extractTopics(conv)),
        first_message_at: timestamps[0] || null,
        last_message_at: timestamps[timestamps.length - 1] || null,
        metadata: {
          model: conv.metadata?.model || null,
          source_format: conv.metadata?.format || `${platform}_export`
        },
        messages: conv.messages.map((m, idx) => ({
          message_idx: idx,
          role: m.role,
          content: m.content,
          model: m.model || null,
          created_at: m.timestamp || null,
          platform_message_id: m.id || null
        }))
      }
    })

    try {
      const archiveResult = await memoryClient.saveConversationBatch(archiveBatch)
      results.conversationsArchived += archiveResult.saved || 0
      results.conversationsSkipped += archiveResult.skipped || 0
    } catch (e) {
      results.errors.push({ archive_batch: `${i}-${i + chunk.length}`, error: e.message })
    }

    if (onProgress) {
      onProgress({
        current: normalized.length,
        total: normalized.length,
        status: `Archived ${Math.min(i + CONV_BATCH_SIZE, normalized.length)}/${normalized.length} conversations`
      })
    }

    await yieldToUI()
  }

  // Phase 4: Update style profile
  if (updateStyle && normalized.length > 0) {
    const styleAnalysis = analyzeImportedStyle(normalized)
    if (styleAnalysis.confidence > 0.3) {
      updateStyleProfile({
        signals: styleAnalysis.style,
        confidence: styleAnalysis.confidence
      })
      results.styleUpdated = true
      results.styleAnalysis = styleAnalysis
    }
  }

  return results
}
