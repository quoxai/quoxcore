/**
 * Quox Intent Memory Service
 *
 * Tracks strategic goals and objectives across conversations.
 * Part of Wave 3 Memory Overhaul - "giggly-seeking-beacon"
 */

import { getMemoryManager } from './memoryManager.js'

// ============================================================================
// INTENT SCHEMA
// ============================================================================

/**
 * Intent levels in hierarchy
 */
export const INTENT_LEVELS = {
  strategic: { priority: 1, description: 'Long-term goals (months)', decayDays: 90 },
  tactical: { priority: 2, description: 'Medium-term objectives (weeks)', decayDays: 30 },
  operational: { priority: 3, description: 'Short-term tasks (days)', decayDays: 7 }
}

/**
 * Intent status values
 */
export const INTENT_STATUS = {
  active: 'active',           // Currently being worked on
  paused: 'paused',           // Temporarily on hold
  blocked: 'blocked',         // Waiting on something
  completed: 'completed',     // Successfully finished
  abandoned: 'abandoned'      // Decided not to pursue
}

/**
 * Create a new intent
 */
export function createIntent(options) {
  const {
    name,
    description = '',
    level = 'operational',
    parent = null,
    successCriteria = [],
    status = INTENT_STATUS.active,
    tags = []
  } = options

  const now = new Date().toISOString()

  return {
    id: `intent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    type: 'intent',
    name,
    description,

    goal: {
      name,
      level,
      parent,
      children: []
    },

    status,
    progress: 0,

    successCriteria: successCriteria.map((c, i) => ({
      id: `criterion_${i}`,
      description: typeof c === 'string' ? c : c.description,
      met: false,
      metAt: null
    })),

    currentTasks: [],

    timeline: {
      created: now,
      targetCompletion: null,
      lastWorkedOn: now,
      completedAt: null
    },

    resumptionContext: {
      lastState: '',
      blockers: [],
      nextSteps: []
    },

    provenance: {
      source: 'model_inference',
      createdBy: 'system.intent',
      createdAt: now
    },

    tags,
    metadata: {}
  }
}

// ============================================================================
// INTENT PATTERNS
// ============================================================================

/**
 * Patterns to detect intent signals in conversation
 */
export const INTENT_PATTERNS = {
  // New goal indicators
  newGoal: [
    /\bi(?:'m| am) (?:trying to|working on|building|creating|implementing)\s+(.+)/i,
    /\bmy (?:goal|objective|plan) is (?:to\s+)?(.+)/i,
    /\bi want to\s+(.+)/i,
    /\bwe need to\s+(.+)/i,
    /\blet'?s (?:build|create|implement|work on)\s+(.+)/i
  ],

  // Progress indicators
  progress: [
    /\b(?:done with|finished|completed|wrapped up)\s+(.+)/i,
    /\bjust (?:finished|completed)\s+(.+)/i,
    /\b(.+) is (?:done|complete|finished)/i,
    /\bmoved on (?:from|to)\s+(.+)/i
  ],

  // Blocker indicators
  blocker: [
    /\b(?:stuck on|blocked by|waiting for|can't proceed|need to figure out)\s+(.+)/i,
    /\bthe (?:problem|issue|blocker) is\s+(.+)/i,
    /\bi need (?:help with|to resolve)\s+(.+)/i
  ],

  // Priority indicators
  priority: [
    /\b(?:focus on|prioritize|most important|first|urgent)\s+(.+)/i,
    /\bthis is (?:critical|urgent|top priority)/i,
    /\bdrop everything/i
  ],

  // Pause/resume indicators
  pause: [
    /\bput (?:this|that) on hold/i,
    /\bpause (?:this|the|work on)/i,
    /\bcome back to (?:this|that) later/i
  ],

  resume: [
    /\bpick (?:this|that) back up/i,
    /\bresume (?:work on|the)/i,
    /\blet'?s continue (?:with|on)/i,
    /\bwhere (?:did we leave off|were we)/i
  ],

  // Abandonment indicators
  abandon: [
    /\b(?:forget about|drop|abandon|cancel)\s+(.+)/i,
    /\bdon'?t (?:need to|want to) (?:do|finish) this/i,
    /\bthis isn'?t worth/i
  ]
}

/**
 * Detect intent signals in text
 */
export function detectIntentSignals(text) {
  const signals = []

  for (const [type, patterns] of Object.entries(INTENT_PATTERNS)) {
    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (match) {
        signals.push({
          type,
          match: match[0],
          extracted: match[1] || null,
          pattern: pattern.source
        })
      }
    }
  }

  return signals
}

/**
 * Infer intent level from content
 */
export function inferIntentLevel(content) {
  const contentLower = content.toLowerCase()

  // Strategic indicators
  const strategicKeywords = ['system', 'architecture', 'overhaul', 'redesign', 'product', 'platform', 'vision']
  if (strategicKeywords.some(k => contentLower.includes(k))) {
    return 'strategic'
  }

  // Tactical indicators
  const tacticalKeywords = ['implement', 'build', 'create', 'add feature', 'refactor', 'upgrade']
  if (tacticalKeywords.some(k => contentLower.includes(k))) {
    return 'tactical'
  }

  // Default to operational
  return 'operational'
}

// ============================================================================
// INTENT STORAGE
// ============================================================================

// In-memory intent store (persists via memoryManager)
let intentCache = null

/**
 * Initialize intent cache from memory
 */
async function initializeIntentCache() {
  if (intentCache !== null) return intentCache

  const mm = getMemoryManager()
  const stored = mm.getLearnedItemsByType('intent')

  intentCache = new Map()
  for (const intent of stored) {
    intentCache.set(intent.id, intent)
  }

  return intentCache
}

/**
 * Get all intents
 */
export async function getAllIntents() {
  await initializeIntentCache()
  return Array.from(intentCache.values())
}

/**
 * Get intent by ID
 */
export async function getIntent(intentId) {
  await initializeIntentCache()
  return intentCache.get(intentId) || null
}

/**
 * Get active intents
 */
export async function getActiveIntents() {
  const all = await getAllIntents()
  return all.filter(i => i.status === INTENT_STATUS.active)
}

/**
 * Get intents by level
 */
export async function getIntentsByLevel(level) {
  const all = await getAllIntents()
  return all.filter(i => i.goal.level === level)
}

/**
 * Get intents by status
 */
export async function getIntentsByStatus(status) {
  const all = await getAllIntents()
  return all.filter(i => i.status === status)
}

/**
 * Store a new intent
 */
export async function storeIntent(intent) {
  await initializeIntentCache()

  const mm = getMemoryManager()
  const result = mm.addLearnedItem('intent', intent, {
    source: intent.provenance?.source || 'model_inference',
    createdBy: intent.provenance?.createdBy || 'system.intent'
  })

  if (result) {
    intentCache.set(result.id, result)
  }

  return result
}

/**
 * Update an existing intent
 */
export async function updateIntent(intentId, updates) {
  await initializeIntentCache()

  const existing = intentCache.get(intentId)
  if (!existing) {
    return { success: false, error: 'Intent not found' }
  }

  const updated = {
    ...existing,
    ...updates,
    timeline: {
      ...existing.timeline,
      ...(updates.timeline || {}),
      lastWorkedOn: new Date().toISOString()
    }
  }

  // Update in memory manager
  const mm = getMemoryManager()
  mm.updateLearnedItem(intentId, updated)

  intentCache.set(intentId, updated)

  return { success: true, intent: updated }
}

/**
 * Update intent status
 */
export async function updateIntentStatus(intentId, status, context = {}) {
  const updates = { status }

  if (status === INTENT_STATUS.completed) {
    updates.timeline = { completedAt: new Date().toISOString() }
    updates.progress = 1
  }

  if (status === INTENT_STATUS.blocked && context.blockers) {
    updates.resumptionContext = { blockers: context.blockers }
  }

  if (context.lastState) {
    updates.resumptionContext = {
      ...(updates.resumptionContext || {}),
      lastState: context.lastState
    }
  }

  return updateIntent(intentId, updates)
}

/**
 * Update intent progress
 */
export async function updateIntentProgress(intentId, progress, context = {}) {
  const updates = {
    progress: Math.max(0, Math.min(1, progress))
  }

  if (context.completedTask) {
    const intent = await getIntent(intentId)
    if (intent) {
      updates.currentTasks = (intent.currentTasks || []).map(t =>
        t.task === context.completedTask ? { ...t, completed: true } : t
      )
    }
  }

  if (context.nextSteps) {
    updates.resumptionContext = { nextSteps: context.nextSteps }
  }

  return updateIntent(intentId, updates)
}

/**
 * Add task to intent
 */
export async function addTaskToIntent(intentId, task, contributes = 0.1) {
  const intent = await getIntent(intentId)
  if (!intent) {
    return { success: false, error: 'Intent not found' }
  }

  const currentTasks = intent.currentTasks || []
  currentTasks.push({
    task,
    contributes,
    addedAt: new Date().toISOString(),
    completed: false
  })

  return updateIntent(intentId, { currentTasks })
}

/**
 * Mark criterion as met
 */
export async function markCriterionMet(intentId, criterionId) {
  const intent = await getIntent(intentId)
  if (!intent) {
    return { success: false, error: 'Intent not found' }
  }

  const successCriteria = intent.successCriteria.map(c =>
    c.id === criterionId ? { ...c, met: true, metAt: new Date().toISOString() } : c
  )

  // Calculate progress based on criteria met
  const metCount = successCriteria.filter(c => c.met).length
  const progress = metCount / successCriteria.length

  return updateIntent(intentId, { successCriteria, progress })
}

// ============================================================================
// INTENT MATCHING
// ============================================================================

/**
 * Find intent matching a description
 */
export async function findMatchingIntent(description, options = {}) {
  const {
    minSimilarity = 0.5,
    statusFilter = null
  } = options

  const all = await getAllIntents()
  const candidates = statusFilter
    ? all.filter(i => i.status === statusFilter)
    : all

  // Simple keyword matching (could be enhanced with embeddings)
  const descWords = new Set(description.toLowerCase().split(/\W+/).filter(w => w.length > 2))

  let bestMatch = null
  let bestScore = 0

  for (const intent of candidates) {
    const intentWords = new Set(
      `${intent.name} ${intent.description}`.toLowerCase().split(/\W+/).filter(w => w.length > 2)
    )

    // Jaccard similarity
    const intersection = [...descWords].filter(w => intentWords.has(w)).length
    const union = new Set([...descWords, ...intentWords]).size
    const similarity = union > 0 ? intersection / union : 0

    if (similarity > bestScore && similarity >= minSimilarity) {
      bestScore = similarity
      bestMatch = intent
    }
  }

  return bestMatch
}

/**
 * Find related intents (children/parent)
 */
export async function findRelatedIntents(intentId) {
  const intent = await getIntent(intentId)
  if (!intent) return { parent: null, children: [], siblings: [] }

  const all = await getAllIntents()

  const parent = intent.goal.parent
    ? all.find(i => i.id === intent.goal.parent)
    : null

  const children = all.filter(i => i.goal.parent === intentId)

  const siblings = intent.goal.parent
    ? all.filter(i => i.goal.parent === intent.goal.parent && i.id !== intentId)
    : []

  return { parent, children, siblings }
}

// ============================================================================
// INTENT DETECTION FROM CONVERSATION
// ============================================================================

/**
 * Process conversation for intent updates
 */
export async function processConversationForIntents(query, response, options = {}) {
  const {
    agentId = 'system.intent',
    autoCreate = true
  } = options

  const results = {
    detected: [],
    created: [],
    updated: [],
    errors: []
  }

  // Detect signals in both query and response
  const combinedText = `${query}\n${response}`
  const signals = detectIntentSignals(combinedText)
  results.detected = signals

  for (const signal of signals) {
    try {
      switch (signal.type) {
        case 'newGoal': {
          if (!autoCreate || !signal.extracted) break

          // Check if similar intent exists
          const existing = await findMatchingIntent(signal.extracted, {
            statusFilter: INTENT_STATUS.active
          })

          if (existing) {
            // Update last worked on
            await updateIntent(existing.id, {})
            results.updated.push({ intent: existing, action: 'touched' })
          } else {
            // Create new intent
            const level = inferIntentLevel(signal.extracted)
            const intent = createIntent({
              name: signal.extracted.substring(0, 100),
              description: signal.match,
              level
            })
            intent.provenance.createdBy = agentId
            intent.provenance.source = 'model_inference'

            const stored = await storeIntent(intent)
            if (stored) {
              results.created.push(stored)
            }
          }
          break
        }

        case 'progress': {
          if (!signal.extracted) break

          const intent = await findMatchingIntent(signal.extracted, {
            statusFilter: INTENT_STATUS.active
          })

          if (intent) {
            const newProgress = Math.min(intent.progress + 0.2, 1)
            await updateIntentProgress(intent.id, newProgress, {
              completedTask: signal.extracted
            })
            results.updated.push({ intent, action: 'progress', value: newProgress })
          }
          break
        }

        case 'blocker': {
          if (!signal.extracted) break

          // Find active intents and add blocker
          const activeIntents = await getActiveIntents()
          if (activeIntents.length > 0) {
            const intent = activeIntents[0] // Most recent active
            await updateIntentStatus(intent.id, INTENT_STATUS.blocked, {
              blockers: [signal.extracted]
            })
            results.updated.push({ intent, action: 'blocked', blocker: signal.extracted })
          }
          break
        }

        case 'priority': {
          // Could reprioritize intents based on this signal
          break
        }

        case 'pause': {
          const activeIntents = await getActiveIntents()
          for (const intent of activeIntents.slice(0, 1)) {
            await updateIntentStatus(intent.id, INTENT_STATUS.paused, {
              lastState: 'Paused by user'
            })
            results.updated.push({ intent, action: 'paused' })
          }
          break
        }

        case 'resume': {
          const pausedIntents = await getIntentsByStatus(INTENT_STATUS.paused)
          if (pausedIntents.length > 0) {
            const intent = pausedIntents[pausedIntents.length - 1] // Most recent paused
            await updateIntentStatus(intent.id, INTENT_STATUS.active)
            results.updated.push({ intent, action: 'resumed' })
          }
          break
        }

        case 'abandon': {
          if (!signal.extracted) break

          const intent = await findMatchingIntent(signal.extracted)
          if (intent) {
            await updateIntentStatus(intent.id, INTENT_STATUS.abandoned)
            results.updated.push({ intent, action: 'abandoned' })
          }
          break
        }
      }
    } catch (error) {
      results.errors.push({ signal, error: error.message })
    }
  }

  return results
}

// ============================================================================
// INTENT CONTEXT FOR INJECTION
// ============================================================================

/**
 * Get intent context for system prompt injection
 */
export async function getIntentContext() {
  const all = await getAllIntents()
  const active = all.filter(i => i.status === INTENT_STATUS.active)
  const blocked = all.filter(i => i.status === INTENT_STATUS.blocked)
  const paused = all.filter(i => i.status === INTENT_STATUS.paused)

  // Organize by level
  const strategic = active.filter(i => i.goal.level === 'strategic')
  const tactical = active.filter(i => i.goal.level === 'tactical')
  const operational = active.filter(i => i.goal.level === 'operational')

  // Get current focus (most recently worked on tactical/operational)
  const currentFocus = [...tactical, ...operational]
    .sort((a, b) => new Date(b.timeline.lastWorkedOn) - new Date(a.timeline.lastWorkedOn))[0]

  // Get recent progress
  const recentlyCompleted = all
    .filter(i => i.status === INTENT_STATUS.completed && i.timeline.completedAt)
    .sort((a, b) => new Date(b.timeline.completedAt) - new Date(a.timeline.completedAt))
    .slice(0, 3)

  // Collect blockers
  const blockers = blocked.flatMap(i => i.resumptionContext?.blockers || [])

  return {
    strategicGoals: strategic.map(i => ({
      name: i.name,
      progress: i.progress,
      criteria: i.successCriteria?.length || 0,
      criteriaMet: i.successCriteria?.filter(c => c.met).length || 0
    })),

    currentFocus: currentFocus ? {
      name: currentFocus.name,
      level: currentFocus.goal.level,
      progress: currentFocus.progress,
      lastWorkedOn: currentFocus.timeline.lastWorkedOn,
      nextSteps: currentFocus.resumptionContext?.nextSteps || []
    } : null,

    activeCount: {
      strategic: strategic.length,
      tactical: tactical.length,
      operational: operational.length
    },

    pausedIntents: paused.map(i => i.name),

    blockers,

    recentProgress: recentlyCompleted.map(i => ({
      name: i.name,
      completedAt: i.timeline.completedAt
    })),

    // For context injection as text
    summary: generateIntentSummary(strategic, currentFocus, blockers)
  }
}

/**
 * Generate text summary for context injection
 */
function generateIntentSummary(strategic, currentFocus, blockers) {
  const parts = []

  if (strategic.length > 0) {
    parts.push(`Strategic goals: ${strategic.map(i => `"${i.name}" (${Math.round(i.progress * 100)}%)`).join(', ')}`)
  }

  if (currentFocus) {
    parts.push(`Currently working on: "${currentFocus.name}" (${currentFocus.goal.level}, ${Math.round(currentFocus.progress * 100)}% complete)`)
    if (currentFocus.resumptionContext?.nextSteps?.length > 0) {
      parts.push(`Next steps: ${currentFocus.resumptionContext.nextSteps.slice(0, 3).join('; ')}`)
    }
  }

  if (blockers.length > 0) {
    parts.push(`Blocked by: ${blockers.join('; ')}`)
  }

  return parts.join('\n')
}

// ============================================================================
// INTENT CLEANUP
// ============================================================================

/**
 * Archive old intents based on decay settings
 */
export async function archiveStaleIntents() {
  const all = await getAllIntents()
  const now = Date.now()
  const archived = []

  for (const intent of all) {
    if (intent.status === INTENT_STATUS.completed || intent.status === INTENT_STATUS.abandoned) {
      continue // Already terminal
    }

    const levelConfig = INTENT_LEVELS[intent.goal.level]
    const decayMs = levelConfig.decayDays * 24 * 60 * 60 * 1000
    const lastWorked = new Date(intent.timeline.lastWorkedOn).getTime()

    if (now - lastWorked > decayMs) {
      await updateIntentStatus(intent.id, INTENT_STATUS.abandoned, {
        lastState: 'Auto-archived due to inactivity'
      })
      archived.push(intent)
    }
  }

  return { archived, count: archived.length }
}

/**
 * Get intent statistics
 */
export async function getIntentStats() {
  const all = await getAllIntents()

  const byStatus = {}
  const byLevel = {}

  for (const intent of all) {
    byStatus[intent.status] = (byStatus[intent.status] || 0) + 1
    byLevel[intent.goal.level] = (byLevel[intent.goal.level] || 0) + 1
  }

  const avgProgress = all.length > 0
    ? all.reduce((sum, i) => sum + i.progress, 0) / all.length
    : 0

  return {
    total: all.length,
    byStatus,
    byLevel,
    averageProgress: avgProgress,
    activeCount: byStatus.active || 0,
    completedCount: byStatus.completed || 0
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  // Constants
  INTENT_LEVELS,
  INTENT_STATUS,
  INTENT_PATTERNS,

  // Creation
  createIntent,
  storeIntent,

  // Retrieval
  getAllIntents,
  getIntent,
  getActiveIntents,
  getIntentsByLevel,
  getIntentsByStatus,
  findMatchingIntent,
  findRelatedIntents,

  // Updates
  updateIntent,
  updateIntentStatus,
  updateIntentProgress,
  addTaskToIntent,
  markCriterionMet,

  // Detection
  detectIntentSignals,
  inferIntentLevel,
  processConversationForIntents,

  // Context
  getIntentContext,

  // Maintenance
  archiveStaleIntents,
  getIntentStats
}
