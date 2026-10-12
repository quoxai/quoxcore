/**
 * Quox Context Budget System
 *
 * Deterministic, budget-aware context injection for LLM prompts.
 * Part of Wave 1 Memory Overhaul - "giggly-seeking-beacon"
 */

import { calculateDecayedConfidence, TRUTH_PRIORITY } from './memoryManager.js'

// ============================================================================
// BUDGET CONFIGURATION
// ============================================================================

/**
 * Default context budget configuration
 * Priority 1 = highest (never dropped), higher numbers = lower priority
 */
export const CONTEXT_BUDGET = {
  total: 4000,  // Total token budget for memory context

  layers: {
    // Priority 1: Core identity (never dropped)
    persona: {
      min: 200,
      max: 400,
      priority: 1,
      description: 'Quox identity and personality'
    },

    // Priority 2: User identity (never dropped)
    profile: {
      min: 100,
      max: 300,
      priority: 2,
      description: 'User name, role, preferences'
    },

    // Priority 3: Safety constraints (never dropped)
    constraints: {
      min: 50,
      max: 200,
      priority: 3,
      description: 'Never-do rules and safety constraints'
    },

    // Priority 4: Current session context
    session: {
      min: 100,
      max: 500,
      priority: 4,
      description: 'Current conversation context'
    },

    // Priority 5: Retrieved memories
    memories: {
      min: 200,
      max: 1500,
      priority: 5,
      description: 'Query-relevant learned memories'
    },

    // Priority 6: Entity knowledge
    entities: {
      min: 100,
      max: 500,
      priority: 6,
      description: 'Relevant entities and relationships'
    },

    // Priority 7: Procedures/runbooks
    procedures: {
      min: 0,
      max: 300,
      priority: 7,
      description: 'Relevant procedures and runbooks'
    },

    // Priority 8: Historical summaries
    history: {
      min: 0,
      max: 500,
      priority: 8,
      description: 'Conversation history summaries'
    },

    // Priority 9: Proactive context
    proactive: {
      min: 0,
      max: 300,
      priority: 9,
      description: 'Recent topics, incomplete tasks'
    },

    // Priority 10: Reflections
    reflections: {
      min: 0,
      max: 200,
      priority: 10,
      description: 'Self-improvement insights'
    }
  }
}

// Token estimation (rough: ~4 chars per token)
const CHARS_PER_TOKEN = 4

// ============================================================================
// BUDGET ALLOCATION
// ============================================================================

/**
 * Allocate budget across layers based on priority and available content
 *
 * @param {Object} content - Object with layer names as keys, content strings/arrays as values
 * @param {Object} options - Configuration options
 * @returns {Object} - Allocated content and stats
 */
export function allocateBudget(content, options = {}) {
  const config = options.config || CONTEXT_BUDGET
  const totalBudget = options.budget || config.total

  // Get layers sorted by priority (lowest number = highest priority)
  const layers = Object.entries(config.layers)
    .map(([name, cfg]) => ({ name, ...cfg }))
    .sort((a, b) => a.priority - b.priority)

  const allocation = {}
  const stats = {
    totalBudget,
    allocated: 0,
    remaining: totalBudget,
    dropped: [],
    truncated: []
  }

  // Phase 1: Allocate minimum to each layer (by priority)
  let usedTokens = 0

  for (const layer of layers) {
    const layerContent = content[layer.name]
    if (!layerContent) continue

    const contentTokens = estimateTokens(layerContent)
    const minTokens = Math.min(layer.min, contentTokens)

    if (usedTokens + minTokens <= totalBudget) {
      allocation[layer.name] = {
        content: layerContent,
        tokens: contentTokens,
        allocated: minTokens,
        status: 'minimum'
      }
      usedTokens += minTokens
    } else if (layer.priority <= 3) {
      // High priority layers always get at least something
      const available = Math.max(0, totalBudget - usedTokens)
      allocation[layer.name] = {
        content: truncateToTokens(layerContent, available),
        tokens: available,
        allocated: available,
        status: 'truncated_critical'
      }
      stats.truncated.push(layer.name)
      usedTokens += available
    } else {
      // Lower priority - drop if no space for minimum
      stats.dropped.push(layer.name)
    }
  }

  // Phase 2: Distribute remaining budget proportionally to layers that want more
  const remainingBudget = totalBudget - usedTokens

  if (remainingBudget > 0) {
    const expandable = Object.entries(allocation)
      .filter(([name, data]) => {
        const cfg = config.layers[name]
        return data.tokens > data.allocated && data.allocated < cfg.max
      })
      .sort((a, b) => {
        const cfgA = config.layers[a[0]]
        const cfgB = config.layers[b[0]]
        return cfgA.priority - cfgB.priority
      })

    let budgetToDistribute = remainingBudget

    for (const [name, data] of expandable) {
      if (budgetToDistribute <= 0) break

      const cfg = config.layers[name]
      const wantsMore = Math.min(data.tokens, cfg.max) - data.allocated
      const canGive = Math.min(wantsMore, budgetToDistribute)

      if (canGive > 0) {
        allocation[name].allocated += canGive
        allocation[name].status = 'expanded'

        // If still can't fit all content, truncate
        if (allocation[name].allocated < data.tokens) {
          allocation[name].content = truncateToTokens(content[name], allocation[name].allocated)
          allocation[name].status = 'truncated'
          stats.truncated.push(name)
        }

        budgetToDistribute -= canGive
        usedTokens += canGive
      }
    }
  }

  stats.allocated = usedTokens
  stats.remaining = totalBudget - usedTokens

  return { allocation, stats }
}

// ============================================================================
// RELEVANCE SCORING
// ============================================================================

/**
 * Score memories by relevance to query
 * Higher score = more relevant
 */
export function scoreRelevance(memory, query, options = {}) {
  const {
    semanticWeight = 0.35,
    recencyWeight = 0.25,
    confidenceWeight = 0.2,
    provenanceWeight = 0.1,
    accessWeight = 0.1
  } = options

  // Semantic similarity (keyword overlap for now, embeddings later)
  const semantic = calculateKeywordSimilarity(memory.content || '', query)

  // Recency score (exponential decay)
  const timestamp = new Date(memory.learnedAt || memory.createdAt || 0).getTime()
  const daysSince = (Date.now() - timestamp) / (1000 * 60 * 60 * 24)
  const recency = Math.exp(-daysSince / 30) // 30-day half-life

  // Confidence (with decay)
  const confidence = calculateDecayedConfidence(memory.confidence)

  // Provenance trust
  const provenance = TRUTH_PRIORITY[memory.provenance?.source] || 0.5

  // Access frequency (normalized)
  const accessCount = memory.accessCount || 0
  const access = Math.min(1.0, accessCount / 20) // Cap at 20 accesses

  const score =
    semanticWeight * semantic +
    recencyWeight * recency +
    confidenceWeight * confidence +
    provenanceWeight * provenance +
    accessWeight * access

  return {
    total: score,
    breakdown: { semantic, recency, confidence, provenance, access }
  }
}

/**
 * Calculate keyword similarity (Jaccard index)
 */
function calculateKeywordSimilarity(text1, text2) {
  if (!text1 || !text2) return 0

  const words1 = new Set(
    text1.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2)
      .map(w => w.replace(/[^a-z0-9]/g, ''))
  )

  const words2 = new Set(
    text2.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2)
      .map(w => w.replace(/[^a-z0-9]/g, ''))
  )

  if (words1.size === 0 || words2.size === 0) return 0

  const intersection = [...words1].filter(w => words2.has(w)).length
  const union = new Set([...words1, ...words2]).size

  return intersection / union
}

// ============================================================================
// CONTENT SELECTION
// ============================================================================

/**
 * Select best memories within token budget
 *
 * @param {Array} memories - Array of memory objects
 * @param {string} query - Current query for relevance scoring
 * @param {number} maxTokens - Maximum tokens to use
 * @returns {Array} - Selected memories
 */
export function selectMemories(memories, query, maxTokens, options = {}) {
  if (!memories || memories.length === 0) return []

  // Score all memories
  const scored = memories.map(m => ({
    ...m,
    relevance: scoreRelevance(m, query, options)
  }))

  // Sort by relevance (highest first)
  scored.sort((a, b) => b.relevance.total - a.relevance.total)

  // Select within budget
  const selected = []
  let usedTokens = 0

  for (const memory of scored) {
    const tokens = estimateTokens(memory.content || '')

    if (usedTokens + tokens <= maxTokens) {
      selected.push(memory)
      usedTokens += tokens
    } else if (selected.length === 0) {
      // Always include at least one, truncated if needed
      selected.push({
        ...memory,
        content: truncateToTokens(memory.content, maxTokens),
        truncated: true
      })
      break
    }
  }

  return selected
}

/**
 * Group and prioritize memories by type
 */
export function prioritizeByType(memories, typeOrder = null) {
  const order = typeOrder || ['constraint', 'preference', 'fact', 'decision', 'error', 'reflection']

  const grouped = {}
  for (const memory of memories) {
    const type = memory.type || 'other'
    if (!grouped[type]) grouped[type] = []
    grouped[type].push(memory)
  }

  // Return in priority order
  const result = []
  for (const type of order) {
    if (grouped[type]) {
      result.push(...grouped[type])
    }
  }

  // Add any types not in the order list
  for (const [type, items] of Object.entries(grouped)) {
    if (!order.includes(type)) {
      result.push(...items)
    }
  }

  return result
}

// ============================================================================
// CONTEXT ASSEMBLY
// ============================================================================

/**
 * Assemble full context within budget
 *
 * @param {Object} sources - Raw content sources
 * @param {string} query - Current query
 * @param {Object} options - Configuration
 * @returns {Object} - Assembled context
 */
export function assembleContext(sources, query, options = {}) {
  const budget = options.budget || CONTEXT_BUDGET.total

  // Score and select memories if provided as array
  if (Array.isArray(sources.memories)) {
    const memoryBudget = CONTEXT_BUDGET.layers.memories.max
    sources.memories = selectMemories(sources.memories, query, memoryBudget)
      .map(m => formatMemoryForContext(m))
      .join('\n')
  }

  // Allocate budget
  const { allocation, stats } = allocateBudget(sources, { budget })

  // Build final context string
  const parts = []

  // Add in priority order
  const orderedLayers = Object.entries(allocation)
    .sort((a, b) => {
      const cfgA = CONTEXT_BUDGET.layers[a[0]]
      const cfgB = CONTEXT_BUDGET.layers[b[0]]
      return (cfgA?.priority || 99) - (cfgB?.priority || 99)
    })

  for (const [name, data] of orderedLayers) {
    if (data.content && data.allocated > 0) {
      parts.push({
        layer: name,
        content: typeof data.content === 'string' ? data.content : JSON.stringify(data.content),
        tokens: data.allocated
      })
    }
  }

  return {
    parts,
    text: parts.map(p => p.content).join('\n\n'),
    stats: {
      ...stats,
      layerCount: parts.length,
      totalTokens: parts.reduce((sum, p) => sum + p.tokens, 0)
    }
  }
}

/**
 * Format a memory for context injection
 */
function formatMemoryForContext(memory) {
  const conf = memory.relevance?.total || calculateDecayedConfidence(memory.confidence)
  const confLabel = conf >= 0.7 ? '' : conf >= 0.4 ? ' (uncertain)' : ' (low confidence)'

  return `- ${memory.content}${confLabel}`
}

// ============================================================================
// TOKEN UTILITIES
// ============================================================================

/**
 * Estimate token count from text
 */
export function estimateTokens(content) {
  if (!content) return 0

  if (typeof content === 'string') {
    return Math.ceil(content.length / CHARS_PER_TOKEN)
  }

  if (Array.isArray(content)) {
    return content.reduce((sum, item) => sum + estimateTokens(item), 0)
  }

  if (typeof content === 'object') {
    return estimateTokens(JSON.stringify(content))
  }

  return 0
}

/**
 * Truncate content to fit within token limit
 */
export function truncateToTokens(content, maxTokens) {
  if (!content) return ''

  const maxChars = maxTokens * CHARS_PER_TOKEN

  if (typeof content === 'string') {
    if (content.length <= maxChars) return content

    // Truncate with ellipsis
    return content.substring(0, maxChars - 3) + '...'
  }

  if (Array.isArray(content)) {
    const result = []
    let usedChars = 0

    for (const item of content) {
      const itemStr = typeof item === 'string' ? item : JSON.stringify(item)
      if (usedChars + itemStr.length <= maxChars) {
        result.push(item)
        usedChars += itemStr.length + 1 // +1 for separator
      } else {
        break
      }
    }

    return result
  }

  return content
}

// ============================================================================
// INJECTION POLICY
// ============================================================================

/**
 * Injection policy configuration
 */
export const INJECTION_POLICY = {
  // Always include regardless of query
  mandatory: ['persona', 'profile', 'constraints'],

  // Include if query-relevant
  queryDependent: ['memories', 'entities', 'procedures'],

  // Include if space permits
  optional: ['history', 'reflections', 'proactive'],

  // Recency preferences
  recency: {
    maxAge: 7 * 24 * 60 * 60 * 1000,  // 7 days
    decayStart: 24 * 60 * 60 * 1000    // 1 day
  },

  // Minimum confidence for inclusion
  minConfidence: 0.3,

  // Maximum items per memory type
  maxPerType: {
    preference: 5,
    constraint: 5,
    fact: 5,
    decision: 3,
    error: 3,
    reflection: 3
  }
}

/**
 * Apply injection policy to filter content
 */
export function applyInjectionPolicy(sources, query, options = {}) {
  const policy = options.policy || INJECTION_POLICY
  const filtered = {}

  for (const [layer, content] of Object.entries(sources)) {
    // Mandatory layers always included
    if (policy.mandatory.includes(layer)) {
      filtered[layer] = content
      continue
    }

    // Query-dependent layers need relevance check
    if (policy.queryDependent.includes(layer)) {
      if (Array.isArray(content)) {
        // Filter by relevance and confidence
        const relevant = content.filter(item => {
          const conf = calculateDecayedConfidence(item.confidence)
          if (conf < policy.minConfidence) return false

          const relevance = scoreRelevance(item, query)
          return relevance.total > 0.2 // Minimum relevance threshold
        })

        if (relevant.length > 0) {
          filtered[layer] = relevant
        }
      } else if (content) {
        filtered[layer] = content
      }
      continue
    }

    // Optional layers only if we have budget space
    if (policy.optional.includes(layer) && content) {
      filtered[layer] = content
    }
  }

  return filtered
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  CONTEXT_BUDGET,
  INJECTION_POLICY,
  allocateBudget,
  scoreRelevance,
  selectMemories,
  prioritizeByType,
  assembleContext,
  estimateTokens,
  truncateToTokens,
  applyInjectionPolicy
}
