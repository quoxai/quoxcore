/**
 * Quox Working Set Memory (WSM)
 *
 * The "RAM" of the user relationship - not long-term storage, but the
 * active, current state that makes Quox feel present and aware.
 *
 * Unlike episodic/semantic memory (the "disk"), WSM is:
 * - Constantly refreshed
 * - Session-aware but persists across sessions
 * - Focused on "what's happening NOW"
 * - The primary source for most prompts (not deep retrieval)
 *
 * Components:
 * 1. Active Projects - What the user is currently working on
 * 2. Current Focus - The immediate goal/task
 * 3. Recent Entities - Recently mentioned hosts/services/people
 * 4. Open Loops - Unresolved threads, pending decisions
 * 5. Active Decisions - Recent choices that affect current work
 * 6. Pain Points - Current frustrations or blockers
 * 7. Session Context - What's happened in this conversation
 *
 * TIERED: Full WSM requires Advanced Memory Plugin (one-time purchase)
 * Free version gets basic focus tracking only
 */

import { getMemoryManager } from './memoryManager'
import { hasFeature, createUpgradePrompt } from './memoryTier'

// ============================================================================
// TIER GATING
// ============================================================================

/**
 * Check if full WSM is available (Premium only)
 * Basic focus tracking is available for all tiers
 * @returns {{ available: boolean, upgrade?: object }}
 */
export function isWSMAvailable() {
  const available = hasFeature('hasWSM')
  if (!available) {
    return {
      available: false,
      basicFocusOnly: true,
      upgrade: createUpgradePrompt('wsm')
    }
  }
  return { available: true, basicFocusOnly: false }
}

/**
 * Check if a premium WSM feature is available
 * Returns upgrade prompt if not
 */
function requireWSMPremium() {
  if (!hasFeature('hasWSM')) {
    return { blocked: true, reason: 'premium_required', upgrade: createUpgradePrompt('wsm') }
  }
  return null
}

import { personalGet, personalSet } from './orgScopedStorage'
import { getMemoryClient } from './memoryClient'
import { logOpenLoopCreated, logOpenLoopResolved } from './memoryAudit'

// QMH2-CONSOLIDATION: WSM used to sync to auth-service preferences JSON
// (users.preferences_json, via queueSync('workingSetMemory', ...)) — the
// WRONG store, and duplicated with the org-scoped auto-sync that personalSet
// already performed via ORG_NAMESPACE_MAP. Both auth-prefs paths are retired;
// identity_blobs (memory service) is now the single sanctioned durable store.
const memoryClient = getMemoryClient()
const WSM_NAMESPACE = 'working_set'

// Configuration
const CONFIG = {
  // How many recent entities to track
  maxRecentEntities: 20,
  // How long entities stay "recent" (24 hours)
  entityRecencyMs: 24 * 60 * 60 * 1000,
  // Max active projects
  maxActiveProjects: 5,
  // Max open loops
  maxOpenLoops: 15,
  // How long open loops persist before auto-decay (30 days)
  openLoopDecayDays: 30,
  // Max active decisions
  maxActiveDecisions: 10,
  // Decision relevance window (7 days)
  decisionRelevanceDays: 7
}

// ============================================================================
// WORKING SET SCHEMA
// ============================================================================

function createEmptyWorkingSet() {
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),

    // Current focus - the immediate thing
    currentFocus: {
      task: null,           // Current task description
      project: null,        // Which project it's for
      goal: null,           // What we're trying to achieve
      startedAt: null,
      context: {}           // Additional context
    },

    // Active projects being worked on
    activeProjects: [
      // { id, name, description, status, lastWorkedOn, priority }
    ],

    // Recently referenced entities (hosts, services, people, etc.)
    recentEntities: [
      // { type, id, name, lastMentioned, mentionCount, context }
    ],

    // Open loops - unresolved threads
    openLoops: [
      // See OPEN_LOOP_SCHEMA below
    ],

    // Active decisions - recent choices affecting current work
    activeDecisions: [
      // { id, decision, rationale, madeAt, context, reversible, alternatives }
    ],

    // Current pain points - frustrations or blockers
    painPoints: [
      // { id, description, severity, firstMentioned, resolved, relatedTo }
    ],

    // Session context - what's happened this conversation
    sessionContext: {
      sessionId: null,
      startedAt: null,
      topicsDiscussed: [],
      questionsAsked: [],
      decisionsDiscussed: [],
      entitiesMentioned: [],
      messageCount: 0
    },

    // User state signals
    userState: {
      apparentMood: 'neutral',    // neutral, frustrated, excited, confused, rushed
      engagementLevel: 'normal',  // low, normal, high, deep
      lastInferred: null
    }
  }
}

// ============================================================================
// OPEN LOOP SCHEMA
// ============================================================================

/**
 * Open Loop - an unresolved thread that persists across sessions
 */
const OPEN_LOOP_STATUS = {
  open: 'open',           // Actively unresolved
  pending: 'pending',     // Waiting on something external
  paused: 'paused',       // User explicitly paused
  resolved: 'resolved',   // Completed
  abandoned: 'abandoned'  // User gave up
}

const OPEN_LOOP_TYPES = {
  question: 'question',       // A question that wasn't fully answered
  task: 'task',              // A task that was started but not finished
  decision: 'decision',      // A decision that needs to be made
  investigation: 'investigation', // Something being researched
  followup: 'followup',      // Something to follow up on later
  reminder: 'reminder'       // Something the user wanted to remember
}

function createOpenLoop(options) {
  const {
    type,
    description,
    context = {},
    priority = 'medium',
    dueBy = null,
    relatedEntities = [],
    relatedProject = null,
    trigger = null  // What should trigger this to resurface
  } = options

  return {
    id: `loop_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    type,
    description,
    status: OPEN_LOOP_STATUS.open,
    priority, // low, medium, high, urgent

    context: {
      ...context,
      originalQuery: context.originalQuery || null,
      whatWasDiscussed: context.whatWasDiscussed || null,
      whereWeLeftOff: context.whereWeLeftOff || null
    },

    timeline: {
      createdAt: new Date().toISOString(),
      lastTouchedAt: new Date().toISOString(),
      dueBy,
      resolvedAt: null
    },

    relationships: {
      relatedEntities,
      relatedProject,
      relatedLoops: []  // Links to other open loops
    },

    trigger,  // { type: 'keyword' | 'time' | 'entity', value: ... }

    resolution: {
      outcome: null,
      notes: null
    }
  }
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Get current working set
 */
export function getWorkingSet() {
  return loadWorkingSet()
}

/**
 * Update current focus
 */
/**
 * Get the current focus
 * @returns {object} Current focus state
 */
export function getCurrentFocus() {
  const ws = getWorkingSet()
  return ws.currentFocus
}

export function setCurrentFocus(focus) {
  const ws = loadWorkingSet()

  ws.currentFocus = {
    task: focus.task || null,
    project: focus.project || ws.currentFocus.project,
    goal: focus.goal || null,
    startedAt: new Date().toISOString(),
    context: focus.context || {}
  }

  ws.lastUpdated = new Date().toISOString()
  saveWorkingSet(ws)
  return ws.currentFocus
}

/**
 * Clear current focus (task completed or switched)
 */
export function clearCurrentFocus(reason = 'completed') {
  const ws = loadWorkingSet()

  // If there was a focus, potentially create an open loop
  if (ws.currentFocus.task && reason === 'interrupted') {
    addOpenLoop({
      type: OPEN_LOOP_TYPES.task,
      description: ws.currentFocus.task,
      context: {
        whereWeLeftOff: 'Interrupted before completion',
        relatedProject: ws.currentFocus.project
      },
      relatedProject: ws.currentFocus.project
    })
  }

  ws.currentFocus = {
    task: null,
    project: null,
    goal: null,
    startedAt: null,
    context: {}
  }

  ws.lastUpdated = new Date().toISOString()
  saveWorkingSet(ws)
}

// ============================================================================
// ACTIVE PROJECTS
// ============================================================================

/**
 * Add or update an active project
 */
export function setActiveProject(project) {
  const ws = loadWorkingSet()

  const existing = ws.activeProjects.findIndex(p =>
    p.id === project.id || p.name.toLowerCase() === project.name?.toLowerCase()
  )

  const projectData = {
    id: project.id || `proj_${Date.now()}`,
    name: project.name,
    description: project.description || null,
    status: project.status || 'active',
    lastWorkedOn: new Date().toISOString(),
    priority: project.priority || 'medium',
    metadata: project.metadata || {}
  }

  if (existing >= 0) {
    ws.activeProjects[existing] = {
      ...ws.activeProjects[existing],
      ...projectData,
      lastWorkedOn: new Date().toISOString()
    }
  } else {
    ws.activeProjects.unshift(projectData)
    // Trim to max
    if (ws.activeProjects.length > CONFIG.maxActiveProjects) {
      ws.activeProjects = ws.activeProjects.slice(0, CONFIG.maxActiveProjects)
    }
  }

  ws.lastUpdated = new Date().toISOString()
  saveWorkingSet(ws)
  return projectData
}

/**
 * Get active projects
 */
export function getActiveProjects() {
  const ws = loadWorkingSet()
  return ws.activeProjects
}

/**
 * Touch a project (update lastWorkedOn)
 */
export function touchProject(projectNameOrId) {
  const ws = loadWorkingSet()

  const project = ws.activeProjects.find(p =>
    p.id === projectNameOrId ||
    p.name.toLowerCase().includes(projectNameOrId.toLowerCase())
  )

  if (project) {
    project.lastWorkedOn = new Date().toISOString()
    ws.lastUpdated = new Date().toISOString()
    saveWorkingSet(ws)
  }

  return project
}

// ============================================================================
// RECENT ENTITIES
// ============================================================================

/**
 * Record that an entity was mentioned/used
 */
export function touchEntity(entity) {
  const ws = loadWorkingSet()
  const now = Date.now()

  // Clean up old entities first
  ws.recentEntities = ws.recentEntities.filter(e =>
    now - new Date(e.lastMentioned).getTime() < CONFIG.entityRecencyMs
  )

  const existing = ws.recentEntities.findIndex(e =>
    e.type === entity.type && e.id === entity.id
  )

  const entityData = {
    type: entity.type,  // host, service, person, file, container, etc.
    id: entity.id,
    name: entity.name || entity.id,
    lastMentioned: new Date().toISOString(),
    mentionCount: 1,
    context: entity.context || {}
  }

  if (existing >= 0) {
    ws.recentEntities[existing].lastMentioned = new Date().toISOString()
    ws.recentEntities[existing].mentionCount++
    if (entity.context) {
      ws.recentEntities[existing].context = {
        ...ws.recentEntities[existing].context,
        ...entity.context
      }
    }
    // Move to front
    const [moved] = ws.recentEntities.splice(existing, 1)
    ws.recentEntities.unshift(moved)
  } else {
    ws.recentEntities.unshift(entityData)
    // Trim to max
    if (ws.recentEntities.length > CONFIG.maxRecentEntities) {
      ws.recentEntities = ws.recentEntities.slice(0, CONFIG.maxRecentEntities)
    }
  }

  ws.lastUpdated = new Date().toISOString()
  saveWorkingSet(ws)
  return entityData
}

/**
 * Get recent entities, optionally filtered by type
 */
export function getRecentEntities(type = null, limit = 10) {
  const ws = loadWorkingSet()
  const now = Date.now()

  let entities = ws.recentEntities.filter(e =>
    now - new Date(e.lastMentioned).getTime() < CONFIG.entityRecencyMs
  )

  if (type) {
    entities = entities.filter(e => e.type === type)
  }

  return entities.slice(0, limit)
}

// ============================================================================
// OPEN LOOPS
// ============================================================================

/**
 * Add an open loop
 * TIERED: Premium only
 */
export function addOpenLoop(options, parentCorr) {
  // TIER CHECK: Open loops require Premium
  const blocked = requireWSMPremium()
  if (blocked) return blocked

  const ws = loadWorkingSet()
  const loop = createOpenLoop(options)

  ws.openLoops.unshift(loop)

  // Trim and decay old loops
  const now = Date.now()
  ws.openLoops = ws.openLoops
    .filter(l => {
      if (l.status === OPEN_LOOP_STATUS.resolved || l.status === OPEN_LOOP_STATUS.abandoned) {
        // Keep resolved/abandoned for 7 days
        const age = now - new Date(l.timeline.resolvedAt || l.timeline.createdAt).getTime()
        return age < 7 * 24 * 60 * 60 * 1000
      }
      // Auto-decay very old open loops
      const age = now - new Date(l.timeline.createdAt).getTime()
      return age < CONFIG.openLoopDecayDays * 24 * 60 * 60 * 1000
    })
    .slice(0, CONFIG.maxOpenLoops * 2)  // Keep some buffer for resolved ones

  ws.lastUpdated = new Date().toISOString()
  saveWorkingSet(ws)
  logOpenLoopCreated(loop, parentCorr)
  return loop
}

/**
 * Get open loops
 */
export function getOpenLoops(options = {}) {
  const {
    status = null,
    type = null,
    includeResolved = false,
    limit = 10
  } = options

  const ws = loadWorkingSet()

  let loops = ws.openLoops

  if (!includeResolved) {
    loops = loops.filter(l =>
      l.status !== OPEN_LOOP_STATUS.resolved &&
      l.status !== OPEN_LOOP_STATUS.abandoned
    )
  }

  if (status) {
    loops = loops.filter(l => l.status === status)
  }

  if (type) {
    loops = loops.filter(l => l.type === type)
  }

  return loops.slice(0, limit)
}

/**
 * Touch an open loop (update lastTouchedAt)
 */
export function touchOpenLoop(loopId, updates = {}) {
  const ws = loadWorkingSet()
  const loop = ws.openLoops.find(l => l.id === loopId)

  if (loop) {
    loop.timeline.lastTouchedAt = new Date().toISOString()

    if (updates.status) loop.status = updates.status
    if (updates.context) {
      loop.context = { ...loop.context, ...updates.context }
    }
    if (updates.whereWeLeftOff) {
      loop.context.whereWeLeftOff = updates.whereWeLeftOff
    }

    ws.lastUpdated = new Date().toISOString()
    saveWorkingSet(ws)
  }

  return loop
}

/**
 * Resolve an open loop
 */
export function resolveOpenLoop(loopId, resolution, parentCorr) {
  const ws = loadWorkingSet()
  const loop = ws.openLoops.find(l => l.id === loopId)

  if (loop) {
    loop.status = OPEN_LOOP_STATUS.resolved
    loop.timeline.resolvedAt = new Date().toISOString()
    loop.resolution = {
      outcome: resolution.outcome || 'completed',
      notes: resolution.notes || null
    }

    ws.lastUpdated = new Date().toISOString()
    saveWorkingSet(ws)
    logOpenLoopResolved(loop, parentCorr)
  }

  return loop
}

/**
 * Find open loops relevant to a query
 */
export function findRelevantOpenLoops(query) {
  const queryLower = query.toLowerCase()
  const loops = getOpenLoops({ limit: 20 })

  return loops.filter(loop => {
    // Check description
    if (loop.description.toLowerCase().includes(queryLower)) return true

    // Check related entities
    for (const entity of loop.relationships.relatedEntities) {
      if (entity.toLowerCase().includes(queryLower)) return true
    }

    // Check project
    if (loop.relationships.relatedProject?.toLowerCase().includes(queryLower)) return true

    // Check trigger keywords
    if (loop.trigger?.type === 'keyword') {
      const keywords = Array.isArray(loop.trigger.value) ? loop.trigger.value : [loop.trigger.value]
      for (const kw of keywords) {
        if (queryLower.includes(kw.toLowerCase())) return true
      }
    }

    return false
  })
}

// ============================================================================
// ACTIVE DECISIONS
// ============================================================================

/**
 * Record a decision
 * TIERED: Premium only
 */
export function recordDecision(decision) {
  // TIER CHECK: Decision tracking requires Premium
  const blocked = requireWSMPremium()
  if (blocked) return blocked

  const ws = loadWorkingSet()

  const decisionData = {
    id: `dec_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    decision: decision.decision,
    rationale: decision.rationale || null,
    alternatives: decision.alternatives || [],
    madeAt: new Date().toISOString(),
    context: decision.context || {},
    reversible: decision.reversible !== false,
    relatedProject: decision.relatedProject || null,
    relatedEntities: decision.relatedEntities || []
  }

  ws.activeDecisions.unshift(decisionData)

  // Trim old decisions
  const cutoff = Date.now() - CONFIG.decisionRelevanceDays * 24 * 60 * 60 * 1000
  ws.activeDecisions = ws.activeDecisions
    .filter(d => new Date(d.madeAt).getTime() > cutoff)
    .slice(0, CONFIG.maxActiveDecisions)

  ws.lastUpdated = new Date().toISOString()
  saveWorkingSet(ws)
  return decisionData
}

/**
 * Get recent decisions
 */
export function getRecentDecisions(limit = 5) {
  const ws = loadWorkingSet()
  return ws.activeDecisions.slice(0, limit)
}

// ============================================================================
// PAIN POINTS
// ============================================================================

/**
 * Record a pain point
 * TIERED: Premium only
 */
export function recordPainPoint(painPoint) {
  // TIER CHECK: Pain point tracking requires Premium
  const blocked = requireWSMPremium()
  if (blocked) return blocked

  const ws = loadWorkingSet()

  const data = {
    id: `pain_${Date.now()}`,
    description: painPoint.description,
    severity: painPoint.severity || 'medium', // low, medium, high
    firstMentioned: new Date().toISOString(),
    lastMentioned: new Date().toISOString(),
    mentionCount: 1,
    resolved: false,
    relatedTo: painPoint.relatedTo || []
  }

  // Check if similar pain point exists
  const existing = ws.painPoints.find(p =>
    p.description.toLowerCase().includes(painPoint.description.toLowerCase().substring(0, 20)) ||
    painPoint.description.toLowerCase().includes(p.description.toLowerCase().substring(0, 20))
  )

  if (existing && !existing.resolved) {
    existing.lastMentioned = new Date().toISOString()
    existing.mentionCount++
    if (painPoint.severity === 'high' ||
        (painPoint.severity === 'medium' && existing.severity === 'low')) {
      existing.severity = painPoint.severity
    }
  } else {
    ws.painPoints.unshift(data)
    // Keep only unresolved + last 5 resolved
    const unresolved = ws.painPoints.filter(p => !p.resolved)
    const resolved = ws.painPoints.filter(p => p.resolved).slice(0, 5)
    ws.painPoints = [...unresolved.slice(0, 10), ...resolved]
  }

  ws.lastUpdated = new Date().toISOString()
  saveWorkingSet(ws)
  return data
}

/**
 * Resolve a pain point
 */
export function resolvePainPoint(painPointId) {
  const ws = loadWorkingSet()
  const pp = ws.painPoints.find(p => p.id === painPointId)

  if (pp) {
    pp.resolved = true
    pp.resolvedAt = new Date().toISOString()
    ws.lastUpdated = new Date().toISOString()
    saveWorkingSet(ws)
  }

  return pp
}

/**
 * Get active pain points
 */
export function getActivePainPoints() {
  const ws = loadWorkingSet()
  return ws.painPoints.filter(p => !p.resolved)
}

// ============================================================================
// SESSION CONTEXT
// ============================================================================

/**
 * Start or update session context
 */
export function updateSessionContext(updates) {
  const ws = loadWorkingSet()

  if (!ws.sessionContext.sessionId || updates.newSession) {
    ws.sessionContext = {
      sessionId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      topicsDiscussed: [],
      questionsAsked: [],
      decisionsDiscussed: [],
      entitiesMentioned: [],
      messageCount: 0
    }
  }

  if (updates.topic && !ws.sessionContext.topicsDiscussed.includes(updates.topic)) {
    ws.sessionContext.topicsDiscussed.push(updates.topic)
  }

  if (updates.question) {
    ws.sessionContext.questionsAsked.push({
      question: updates.question,
      askedAt: new Date().toISOString()
    })
  }

  if (updates.entity && !ws.sessionContext.entitiesMentioned.includes(updates.entity)) {
    ws.sessionContext.entitiesMentioned.push(updates.entity)
  }

  if (updates.incrementMessageCount) {
    ws.sessionContext.messageCount++
  }

  ws.lastUpdated = new Date().toISOString()
  saveWorkingSet(ws)
  return ws.sessionContext
}

/**
 * Get session context
 */
export function getSessionContext() {
  const ws = loadWorkingSet()
  return ws.sessionContext
}

// ============================================================================
// USER STATE
// ============================================================================

/**
 * Update inferred user state
 */
export function updateUserState(state) {
  const ws = loadWorkingSet()

  ws.userState = {
    apparentMood: state.mood || ws.userState.apparentMood,
    engagementLevel: state.engagement || ws.userState.engagementLevel,
    lastInferred: new Date().toISOString()
  }

  ws.lastUpdated = new Date().toISOString()
  saveWorkingSet(ws)
  return ws.userState
}

// ============================================================================
// CONTEXT GENERATION
// ============================================================================

/**
 * Generate WSM context for prompt injection
 * This is the key function that produces the "RAM" context
 * TIERED: Free version gets basic focus only, Advanced Memory Plugin gets full context
 */
export function generateWSMContext(options = {}) {
  const isPremium = hasFeature('hasWSM')

  const {
    maxTokens = 800,
    includeOpenLoops = isPremium,  // Only for Premium
    includeDecisions = isPremium,   // Only for Premium
    includePainPoints = isPremium   // Only for Premium
  } = options

  const ws = loadWorkingSet()
  const lines = []

  lines.push('### Current Working Context\n')

  // Current focus - available to all tiers
  if (ws.currentFocus.task) {
    lines.push(`**Current Task:** ${ws.currentFocus.task}`)
    if (ws.currentFocus.goal) {
      lines.push(`**Goal:** ${ws.currentFocus.goal}`)
    }
    if (ws.currentFocus.project) {
      lines.push(`**Project:** ${ws.currentFocus.project}`)
    }
    lines.push('')
  }

  // Free version gets basic focus only
  if (!isPremium) {
    const context = lines.join('\n')
    const estimatedTokens = Math.ceil(context.length / 4)
    return {
      context,
      estimatedTokens,
      withinBudget: true,
      limited: true,
      reason: 'Free version - basic focus only (purchase Advanced Memory Plugin for full WSM)'
    }
  }

  // Premium features below

  // Active projects
  const activeProjects = ws.activeProjects.filter(p => p.status === 'active').slice(0, 3)
  if (activeProjects.length > 0) {
    lines.push('**Active Projects:**')
    for (const p of activeProjects) {
      lines.push(`- ${p.name}${p.description ? ': ' + p.description : ''}`)
    }
    lines.push('')
  }

  // Recent entities
  const recentEntities = getRecentEntities(null, 8)
  if (recentEntities.length > 0) {
    const entityList = recentEntities.map(e =>
      `${e.name}${e.type !== 'general' ? ` (${e.type})` : ''}`
    ).join(', ')
    lines.push(`**Recently Referenced:** ${entityList}`)
    lines.push('')
  }

  // Open loops
  if (includeOpenLoops) {
    const openLoops = getOpenLoops({ limit: 5 })
    if (openLoops.length > 0) {
      lines.push('**Open Threads:**')
      for (const loop of openLoops) {
        const priority = loop.priority === 'high' || loop.priority === 'urgent' ? ' (!)' : ''
        lines.push(`- ${loop.description}${priority}`)
        if (loop.context.whereWeLeftOff) {
          lines.push(`  ↳ Left off: ${loop.context.whereWeLeftOff}`)
        }
      }
      lines.push('')
    }
  }

  // Recent decisions
  if (includeDecisions) {
    const decisions = getRecentDecisions(3)
    if (decisions.length > 0) {
      lines.push('**Recent Decisions:**')
      for (const d of decisions) {
        lines.push(`- ${d.decision}${d.rationale ? ' (' + d.rationale + ')' : ''}`)
      }
      lines.push('')
    }
  }

  // Pain points
  if (includePainPoints) {
    const painPoints = getActivePainPoints().filter(p => p.severity !== 'low').slice(0, 3)
    if (painPoints.length > 0) {
      lines.push('**Known Issues:**')
      for (const pp of painPoints) {
        lines.push(`- ${pp.description}`)
      }
      lines.push('')
    }
  }

  // Session context (brief)
  if (ws.sessionContext.topicsDiscussed.length > 0) {
    lines.push(`**This Session:** ${ws.sessionContext.topicsDiscussed.slice(-5).join(', ')}`)
  }

  const context = lines.join('\n')

  // Rough token estimate (4 chars per token)
  const estimatedTokens = Math.ceil(context.length / 4)

  return {
    context,
    estimatedTokens,
    withinBudget: estimatedTokens <= maxTokens
  }
}

/**
 * Process a user message to update WSM
 * Call this on every user input to keep WSM fresh
 */
export function processUserMessage(message, options = {}) {
  const {
    detectedEntities = [],
    detectedTopics = [],
    isQuestion = false,
    currentProject = null,
    conversationCorr = null
  } = options

  // Update session context
  updateSessionContext({
    incrementMessageCount: true
  })

  // Record detected entities
  for (const entity of detectedEntities) {
    touchEntity(entity)
  }

  // Record detected topics
  for (const topic of detectedTopics) {
    updateSessionContext({ topic })
  }

  // Record if question
  if (isQuestion) {
    updateSessionContext({ question: message.substring(0, 200) })
  }

  // Touch current project if detected
  if (currentProject) {
    touchProject(currentProject)
  }

  // Check for open loop triggers
  const relevantLoops = findRelevantOpenLoops(message)
  for (const loop of relevantLoops) {
    touchOpenLoop(loop.id)
  }

  return {
    updatedEntities: detectedEntities.length,
    triggeredLoops: relevantLoops.length,
    relevantLoops
  }
}

// ============================================================================
// STORAGE HELPERS
// ============================================================================

function loadWorkingSet() {
  try {
    const stored = personalGet('wsm')
    if (stored) {
      const ws = JSON.parse(stored)
      // Ensure all fields exist (for backwards compatibility)
      return {
        ...createEmptyWorkingSet(),
        ...ws
      }
    }
  } catch (e) {
    console.warn('[WSM] Failed to load working set:', e)
  }
  return createEmptyWorkingSet()
}

function saveWorkingSet(ws) {
  try {
    personalSet('wsm', JSON.stringify(ws))
    // identity_blobs write-through (memory service) — the sanctioned durable
    // store for cross-device persistence. Fire-and-forget: localStorage stays
    // the fast synchronous read path.
    _wsmWriteThrough(ws)
  } catch (e) {
    console.warn('[WSM] Failed to save working set:', e)
  }
}

function _wsmWriteThrough(ws) {
  try {
    memoryClient.setIdentity(WSM_NAMESPACE, ws).catch(err => {
      console.warn('[WSM] Identity write-through failed:', err.message)
    })
  } catch (err) {
    console.warn('[WSM] Identity write-through error:', err.message)
  }
}

/**
 * Hydrate the org-scoped WSM local cache from the memory service.
 *
 * WSM's local cache key is dynamic (quox_{org}_{user}_wsm, via
 * personalGet/personalSet) so it is NOT covered by
 * memoryManager.hydrateIdentityFromServer() (which only hydrates static
 * top-level keys). Must be called AFTER setStorageContext(org, user) is set
 * — call once on auth and again on every 'quox-org-switch' so switching orgs
 * hydrates the newly-selected org's blob. Never overwrites an existing local
 * cache; best-effort (failures are logged and swallowed).
 */
export async function hydrateWorkingSetFromServer() {
  try {
    if (personalGet('wsm')) return
    const result = await memoryClient.getIdentity(WSM_NAMESPACE)
    if (result && result.data !== null && result.data !== undefined) {
      personalSet('wsm', JSON.stringify(result.data))
    }
  } catch (err) {
    console.warn('[WSM] Identity hydration failed:', err.message)
  }
}

/**
 * Reset working set (for testing or fresh start)
 */
export function resetWorkingSet() {
  saveWorkingSet(createEmptyWorkingSet())
}

/**
 * Export working set for backup
 */
export function exportWorkingSet() {
  return {
    workingSet: loadWorkingSet(),
    exportedAt: new Date().toISOString(),
    version: '1.0'
  }
}

/**
 * Import working set from backup
 */
export function importWorkingSet(data) {
  if (data.workingSet) {
    saveWorkingSet({
      ...createEmptyWorkingSet(),
      ...data.workingSet
    })
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  OPEN_LOOP_STATUS,
  OPEN_LOOP_TYPES,
  CONFIG as WSM_CONFIG
}

export default {
  // Tier Gating
  isWSMAvailable,

  // Core
  getWorkingSet,

  // Focus
  setCurrentFocus,
  clearCurrentFocus,

  // Projects
  setActiveProject,
  getActiveProjects,
  touchProject,

  // Entities
  touchEntity,
  getRecentEntities,

  // Open Loops (Premium)
  addOpenLoop,
  getOpenLoops,
  touchOpenLoop,
  resolveOpenLoop,
  findRelevantOpenLoops,

  // Decisions (Premium)
  recordDecision,
  getRecentDecisions,

  // Pain Points (Premium)
  recordPainPoint,
  resolvePainPoint,
  getActivePainPoints,

  // Session
  updateSessionContext,
  getSessionContext,

  // User State
  updateUserState,

  // Context Generation
  generateWSMContext,
  processUserMessage,

  // Utilities
  resetWorkingSet,
  exportWorkingSet,
  importWorkingSet,

  // Server hydration (QMH2-CONSOLIDATION)
  hydrateWorkingSetFromServer,

  // Constants
  OPEN_LOOP_STATUS,
  OPEN_LOOP_TYPES
}
