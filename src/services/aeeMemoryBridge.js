/**
 * AEE Memory Bridge
 *
 * Bridges AEE envelopes to Quox's memory system.
 * - Listens for completed conversations
 * - Extracts memories automatically
 * - Updates entity graph
 * - Enables conversation-aware memory retrieval
 *
 * @fileoverview The nervous system connecting AEE signals to memory
 */

import {
  getConversation,
  queryEnvelopes,
  getStats
} from '../lib/aee'
import { CHAT_INTENTS, QuoxAgent_INTENTS, OPS_INTENTS } from '../lib/aee/intents.js'

// ============================================================================
// Memory Extraction from Conversations
// ============================================================================

/**
 * Extract learnable memories from a completed conversation
 *
 * @param {string} corr - Correlation ID of the conversation
 * @param {Object} memoryManager - Memory manager instance
 * @returns {Object} Extraction results
 */
export async function extractMemoriesFromConversation(corr, memoryManager) {
  const envelopes = await getConversation(corr)

  if (!envelopes || envelopes.length === 0) {
    return { extracted: 0, entities: 0, errors: [] }
  }

  const results = {
    extracted: 0,
    entities: 0,
    errors: [],
    memories: [],
    entities_found: []
  }

  // Group by type
  const tasks = envelopes.filter(e => e.type === 'task')
  const taskResults = envelopes.filter(e => e.type === 'result')
  const errors = envelopes.filter(e => e.type === 'error')

  // Extract Q&A pairs from chat
  for (const task of tasks) {
    try {
      if (task.intent === CHAT_INTENTS.QUERY) {
        const result = taskResults.find(r => r.reply_to === task.id)
        if (result && result.payload?.text) {
          // Create a fact memory from Q&A pair
          const memory = {
            type: 'conversation_qa',
            question: task.payload?.text,
            answer: summarizeText(result.payload.text, 500),
            full_answer_length: result.payload.text?.length || 0,
            conversation_id: corr,
            timestamp: task.ts,
            agent: task.to,
            success: true
          }
          results.memories.push(memory)
          results.extracted++
        }
      }

      // Extract operational memories from QuoxAgent jobs
      if (task.intent === QuoxAgent_INTENTS.JOB_SUBMIT) {
        const result = taskResults.find(r => r.reply_to === task.id)
        const host = task.to?.replace('quoxagent.', '')

        const memory = {
          type: 'operation',
          host,
          command: task.payload?.command,
          success: result?.payload?.exit_code === 0,
          exit_code: result?.payload?.exit_code,
          output_summary: result?.payload?.output
            ? summarizeText(result.payload.output, 200)
            : null,
          conversation_id: corr,
          timestamp: task.ts
        }
        results.memories.push(memory)
        results.extracted++

        // Extract host entity
        if (host) {
          results.entities_found.push({
            type: 'host',
            name: host,
            last_command: task.payload?.command,
            last_accessed: task.ts
          })
        }
      }

      // Extract approval decisions
      if (task.intent === OPS_INTENTS.APPROVAL_REQUEST) {
        const result = taskResults.find(r => r.reply_to === task.id)
        const granted = result?.intent === OPS_INTENTS.APPROVAL_GRANT

        const memory = {
          type: 'decision',
          operation: task.payload?.operation,
          reason: task.payload?.reason,
          risk_level: task.payload?.risk_level,
          approved: granted,
          approver: result?.from,
          conversation_id: corr,
          timestamp: task.ts
        }
        results.memories.push(memory)
        results.extracted++
      }
    } catch (err) {
      results.errors.push({
        envelope_id: task.id,
        error: err.message
      })
    }
  }

  // Extract entities from all envelopes
  const entities = extractEntitiesFromEnvelopes(envelopes)
  results.entities_found.push(...entities)
  results.entities = results.entities_found.length

  // If memory manager provided, store the extracted memories
  if (memoryManager) {
    for (const memory of results.memories) {
      try {
        await memoryManager.addLearnedItem(memory.type, memory)
      } catch (err) {
        results.errors.push({
          memory_type: memory.type,
          error: err.message
        })
      }
    }

    for (const entity of results.entities_found) {
      try {
        await memoryManager.storeEntity(entity)
      } catch (err) {
        // Entity might already exist, not an error
      }
    }
  }

  return results
}

/**
 * Extract entity mentions from envelopes
 *
 * @param {Array} envelopes - Array of AEE envelopes
 * @returns {Array} Extracted entities
 */
export function extractEntitiesFromEnvelopes(envelopes) {
  const entities = new Map()

  // Known patterns for entity extraction
  const hostPattern = /\b(docker\d+|proxmox\d+|kuma\d*|nas\d+|truenas\d*|grafana\d*|prometheus\d*|pihole\d*|pfsense\d*|access\d+)\b/gi
  const ipPattern = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g
  const containerPattern = /\b(container|docker)[\s:]+([a-zA-Z0-9_-]+)\b/gi
  const servicePattern = /\b(nginx|redis|postgres|mysql|mongodb|elasticsearch|n8n|grafana|prometheus)\b/gi

  for (const envelope of envelopes) {
    const textContent = JSON.stringify(envelope.payload || {})

    // Extract hosts
    const hosts = textContent.match(hostPattern) || []
    for (const host of hosts) {
      const normalized = host.toLowerCase()
      if (!entities.has(`host:${normalized}`)) {
        entities.set(`host:${normalized}`, {
          type: 'host',
          name: normalized,
          mentioned_in: envelope.id,
          timestamp: envelope.ts
        })
      }
    }

    // Extract IPs
    const ips = textContent.match(ipPattern) || []
    for (const ip of ips) {
      if (!entities.has(`ip:${ip}`)) {
        entities.set(`ip:${ip}`, {
          type: 'ip_address',
          name: ip,
          mentioned_in: envelope.id,
          timestamp: envelope.ts
        })
      }
    }

    // Extract services
    const services = textContent.match(servicePattern) || []
    for (const service of services) {
      const normalized = service.toLowerCase()
      if (!entities.has(`service:${normalized}`)) {
        entities.set(`service:${normalized}`, {
          type: 'service',
          name: normalized,
          mentioned_in: envelope.id,
          timestamp: envelope.ts
        })
      }
    }

    // Extract from/to as entities
    if (envelope.from?.startsWith('quoxagent.')) {
      const host = envelope.from.replace('quoxagent.', '')
      if (!entities.has(`host:${host}`)) {
        entities.set(`host:${host}`, {
          type: 'host',
          name: host,
          has_quoxagent: true,
          timestamp: envelope.ts
        })
      }
    }
  }

  return Array.from(entities.values())
}

// ============================================================================
// Contextual Memory Retrieval
// ============================================================================

/**
 * Get memories with context boost from current conversation
 *
 * @param {string} query - Search query
 * @param {string} currentCorr - Current conversation correlation ID
 * @param {Object} memoryManager - Memory manager instance
 * @returns {Array} Boosted and sorted memories
 */
export async function getContextualMemories(query, currentCorr, memoryManager) {
  if (!memoryManager) return []

  // Get base memories from hybrid search
  const memories = await memoryManager.hybridSearch(query)

  if (!currentCorr) return memories

  // Get current conversation context
  const conversation = await getConversation(currentCorr)
  const contextEntities = extractEntitiesFromEnvelopes(conversation)
  const entityNames = contextEntities.map(e => e.name.toLowerCase())

  // Boost memories that involve same entities
  const boosted = memories.map(memory => {
    let boost = 1.0
    const content = JSON.stringify(memory).toLowerCase()

    // Check for entity overlap
    for (const entityName of entityNames) {
      if (content.includes(entityName)) {
        boost += 0.3 // Boost for each matching entity
      }
    }

    // Check for conversation reference
    if (memory.conversation_id === currentCorr) {
      boost += 0.5 // Same conversation boost
    }

    return {
      ...memory,
      _original_score: memory.score,
      _boost: boost,
      score: (memory.score || 0) * boost
    }
  })

  // Sort by boosted score
  return boosted.sort((a, b) => b.score - a.score)
}

/**
 * Get proactive context for a new conversation
 * Based on recent AEE history
 *
 * @param {string} userId - User identifier (e.g., "human.adam")
 * @param {number} lookbackMs - How far back to look (default 24h)
 * @returns {Object} Proactive context
 */
export async function getProactiveContext(userId, lookbackMs = 86400000) {
  const cutoff = new Date(Date.now() - lookbackMs).toISOString()

  // Get recent envelopes from this user
  const recent = await queryEnvelopes({
    from: userId,
    after: cutoff,
    limit: 100
  })

  if (!recent || recent.length === 0) {
    return {
      recent_topics: [],
      incomplete_tasks: [],
      suggested_followups: [],
      activity_summary: null
    }
  }

  // Group by conversation
  const conversations = new Map()
  for (const env of recent) {
    if (!conversations.has(env.corr)) {
      conversations.set(env.corr, [])
    }
    conversations.get(env.corr).push(env)
  }

  // Analyze topics
  const topics = []
  const incomplete = []

  for (const [corr, envs] of conversations) {
    const tasks = envs.filter(e => e.type === 'task')
    const results = envs.filter(e => e.type === 'result')

    // Find first query to get topic
    const firstQuery = tasks.find(t => t.intent === CHAT_INTENTS.QUERY)
    if (firstQuery) {
      topics.push({
        corr,
        topic: summarizeText(firstQuery.payload?.text || '', 100),
        message_count: envs.length,
        timestamp: firstQuery.ts
      })
    }

    // Find incomplete tasks
    for (const task of tasks) {
      const hasResult = results.some(r => r.reply_to === task.id)
      if (!hasResult && task.intent !== CHAT_INTENTS.QUERY) {
        incomplete.push({
          corr,
          task_id: task.id,
          intent: task.intent,
          summary: summarizeText(JSON.stringify(task.payload), 100),
          timestamp: task.ts
        })
      }
    }
  }

  // Generate suggested followups
  const suggested = generateFollowupSuggestions(topics, incomplete)

  return {
    recent_topics: topics.slice(0, 5),
    incomplete_tasks: incomplete.slice(0, 3),
    suggested_followups: suggested,
    activity_summary: {
      conversations: conversations.size,
      total_messages: recent.length,
      time_range: {
        start: recent[recent.length - 1]?.ts,
        end: recent[0]?.ts
      }
    }
  }
}

/**
 * Generate followup suggestions based on recent activity
 *
 * @param {Array} topics - Recent topics
 * @param {Array} incomplete - Incomplete tasks
 * @returns {Array} Suggested followups
 */
function generateFollowupSuggestions(topics, incomplete) {
  const suggestions = []

  // Suggest continuing incomplete tasks
  for (const task of incomplete.slice(0, 2)) {
    suggestions.push({
      type: 'incomplete',
      text: `Continue: ${task.summary}`,
      corr: task.corr,
      priority: 'high'
    })
  }

  // Suggest followups on recent topics
  const recentTopics = topics.slice(0, 3)
  for (const topic of recentTopics) {
    if (!incomplete.some(i => i.corr === topic.corr)) {
      suggestions.push({
        type: 'followup',
        text: `Follow up on: ${topic.topic}`,
        corr: topic.corr,
        priority: 'medium'
      })
    }
  }

  return suggestions.slice(0, 3)
}

// ============================================================================
// Conversation Analysis
// ============================================================================

/**
 * Analyze a completed conversation
 *
 * @param {string} corr - Conversation correlation ID
 * @returns {Object} Analysis results
 */
export async function analyzeConversation(corr) {
  const envelopes = await getConversation(corr)

  if (!envelopes || envelopes.length === 0) {
    return null
  }

  const tasks = envelopes.filter(e => e.type === 'task')
  const results = envelopes.filter(e => e.type === 'result')
  const errors = envelopes.filter(e => e.type === 'error')
  const events = envelopes.filter(e => e.type === 'event')

  // Calculate duration
  const timestamps = envelopes.map(e => new Date(e.ts).getTime())
  const duration_ms = Math.max(...timestamps) - Math.min(...timestamps)

  // Get first query as topic
  const firstQuery = tasks.find(t => t.intent === CHAT_INTENTS.QUERY)
  const topic = firstQuery?.payload?.text || 'Unknown topic'

  // Identify participants
  const participants = new Set()
  for (const env of envelopes) {
    participants.add(env.from)
    participants.add(env.to)
  }

  // Count intents
  const intentCounts = {}
  for (const env of envelopes) {
    intentCounts[env.intent] = (intentCounts[env.intent] || 0) + 1
  }

  // Determine success
  const hasErrors = errors.length > 0
  const allTasksResolved = tasks.every(t =>
    results.some(r => r.reply_to === t.id) ||
    errors.some(e => e.reply_to === t.id)
  )

  // Extract entities involved
  const entities = extractEntitiesFromEnvelopes(envelopes)

  // Extract key learnings (simple heuristic)
  const learnings = []
  for (const result of results) {
    if (result.payload?.text?.includes('learned') ||
        result.payload?.text?.includes('remember') ||
        result.payload?.text?.includes('note that')) {
      learnings.push(summarizeText(result.payload.text, 200))
    }
  }

  return {
    corr,
    topic: summarizeText(topic, 100),
    full_topic: topic,
    message_count: envelopes.length,
    duration_ms,
    duration_human: formatDuration(duration_ms),
    participants: Array.from(participants),
    intent_breakdown: intentCounts,
    success: allTasksResolved && !hasErrors,
    has_errors: hasErrors,
    error_count: errors.length,
    entities_involved: entities.map(e => e.name),
    key_learnings: learnings,
    timestamps: {
      started: envelopes[0]?.ts,
      ended: envelopes[envelopes.length - 1]?.ts
    }
  }
}

// ============================================================================
// Batch Processing
// ============================================================================

/**
 * Process all conversations in a time range
 * Useful for nightly consolidation
 *
 * @param {string} startTime - ISO timestamp
 * @param {string} endTime - ISO timestamp
 * @param {Object} memoryManager - Memory manager instance
 * @returns {Object} Processing results
 */
export async function processConversationsInRange(startTime, endTime, memoryManager) {
  const envelopes = await queryEnvelopes({
    after: startTime,
    before: endTime
  })

  // Group by corr
  const conversations = new Map()
  for (const env of envelopes) {
    if (!conversations.has(env.corr)) {
      conversations.set(env.corr, [])
    }
    conversations.get(env.corr).push(env)
  }

  const results = {
    conversations_processed: 0,
    memories_extracted: 0,
    entities_found: 0,
    errors: []
  }

  for (const [corr] of conversations) {
    try {
      const extraction = await extractMemoriesFromConversation(corr, memoryManager)
      results.conversations_processed++
      results.memories_extracted += extraction.extracted
      results.entities_found += extraction.entities
      results.errors.push(...extraction.errors)
    } catch (err) {
      results.errors.push({
        corr,
        error: err.message
      })
    }
  }

  return results
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Summarize text to a maximum length
 *
 * @param {string} text - Text to summarize
 * @param {number} maxLength - Maximum length
 * @returns {string} Summarized text
 */
function summarizeText(text, maxLength) {
  if (!text) return ''
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength - 3) + '...'
}

/**
 * Format duration in human readable form
 *
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human readable duration
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`
  return `${(ms / 3600000).toFixed(1)}h`
}

// ============================================================================
// Export Default Bridge Interface
// ============================================================================

/**
 * Create a memory bridge instance
 *
 * @param {Object} memoryManager - Memory manager instance
 * @returns {Object} Bridge interface
 */
export function createMemoryBridge(memoryManager) {
  return {
    extractFromConversation: (corr) =>
      extractMemoriesFromConversation(corr, memoryManager),

    getContextual: (query, corr) =>
      getContextualMemories(query, corr, memoryManager),

    getProactive: (userId, lookback) =>
      getProactiveContext(userId, lookback),

    analyze: analyzeConversation,

    processBatch: (start, end) =>
      processConversationsInRange(start, end, memoryManager)
  }
}

export default createMemoryBridge
