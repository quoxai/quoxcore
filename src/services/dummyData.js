/**
 * Dummy Data Service
 *
 * Manages pre-populated demo/test data for the memory system.
 * All dummy data is marked with isDummy: true for easy removal.
 *
 * Usage:
 * - Enable via Settings > General > Development > "Demo Memory Data"
 * - Data is automatically populated/removed when setting changes
 * - Call initDummyDataSystem() on app startup to sync state
 */

import { getUISetting, setUISetting, subscribeToUISettings } from './uiSettings'

// Storage keys for memory types
const MEMORY_TYPES = ['preference', 'fact', 'decision', 'constraint', 'error', 'reflection']

// Marker applied to all dummy items
const createDummyMarker = () => ({
  isDummy: true,
  provenance: {
    source: 'dummy_data',
    createdBy: 'system',
    timestamp: new Date().toISOString()
  }
})

// ============================================================================
// DUMMY DATA DEFINITIONS
// ============================================================================

export const DUMMY_PREFERENCES = [
  {
    content: 'Prefer concise responses over verbose explanations',
    category: 'communication',
    confidence: { score: 0.9, stability: 'stable' }
  },
  {
    content: 'Always show command previews before execution',
    category: 'operations',
    confidence: { score: 0.95, stability: 'stable' }
  },
  {
    content: 'Use dark mode theme for all interfaces',
    category: 'display',
    confidence: { score: 0.85, stability: 'working' }
  },
  {
    content: 'Prefer keyboard shortcuts over mouse navigation',
    category: 'interaction',
    confidence: { score: 0.8, stability: 'working' }
  }
]

export const DUMMY_FACTS = [
  {
    content: 'Demo data is present. To remove it, disable "Demo Memory Data" in Settings > General > Development.',
    category: 'system_notice',
    confidence: { score: 1.0, stability: 'permanent' }
  },
  {
    content: 'JavaScript uses an event loop for asynchronous operations, enabling non-blocking I/O',
    category: 'programming',
    confidence: { score: 0.95, stability: 'stable' }
  },
  {
    content: 'RESTful APIs use HTTP methods: GET (read), POST (create), PUT (replace), PATCH (update), DELETE (remove)',
    category: 'programming',
    confidence: { score: 0.95, stability: 'stable' }
  },
  {
    content: 'Git branches should be named with prefixes: feature/, bugfix/, hotfix/, release/',
    category: 'best_practices',
    confidence: { score: 0.8, stability: 'working' }
  },
  {
    content: 'The 12-factor app methodology recommends storing config in environment variables',
    category: 'architecture',
    confidence: { score: 0.9, stability: 'stable' }
  }
]

export const DUMMY_DECISIONS = [
  {
    content: 'Chose React for frontend due to component reusability, large ecosystem, and team familiarity',
    category: 'architecture',
    context: 'Framework selection for dashboard',
    confidence: { score: 0.9, stability: 'stable' }
  },
  {
    content: 'Selected localStorage for settings persistence - sufficient for single-user, no backend required',
    category: 'storage',
    context: 'Data persistence strategy',
    confidence: { score: 0.85, stability: 'working' }
  },
  {
    content: 'Using CSS variables for theming instead of CSS-in-JS for better performance and simplicity',
    category: 'styling',
    context: 'Theme system implementation',
    confidence: { score: 0.85, stability: 'stable' }
  }
]

export const DUMMY_CONSTRAINTS = [
  {
    content: 'Never execute destructive commands (rm -rf, DROP TABLE, etc.) without explicit confirmation',
    category: 'safety',
    severity: 'critical',
    confidence: { score: 1.0, stability: 'permanent' }
  },
  {
    content: 'Never store API keys, passwords, or secrets in plain text in memory or logs',
    category: 'security',
    severity: 'critical',
    confidence: { score: 1.0, stability: 'permanent' }
  },
  {
    content: 'Avoid running commands with --force or --no-verify flags without user approval',
    category: 'safety',
    severity: 'high',
    confidence: { score: 0.95, stability: 'stable' }
  },
  {
    content: 'Do not make breaking API changes without versioning or deprecation notice',
    category: 'compatibility',
    severity: 'high',
    confidence: { score: 0.9, stability: 'stable' }
  }
]

export const DUMMY_ERRORS = [
  {
    content: 'CORS errors often resolved by checking backend Access-Control-Allow-Origin headers',
    category: 'web',
    solution: 'Configure CORS on server, use proxy in development, or check credentials mode',
    confidence: { score: 0.9, stability: 'stable' }
  },
  {
    content: 'Node MODULE_NOT_FOUND usually means missing dependency installation',
    category: 'nodejs',
    solution: 'Run npm install, check package.json, verify node_modules exists',
    confidence: { score: 0.95, stability: 'stable' }
  },
  {
    content: 'React "Cannot update unmounted component" indicates memory leak from async operations',
    category: 'react',
    solution: 'Add cleanup in useEffect return, use AbortController for fetch, check mounted state',
    confidence: { score: 0.9, stability: 'stable' }
  }
]

export const DUMMY_REFLECTIONS = [
  {
    content: 'User frequently asks about debugging - consider proactive error explanations and stack trace analysis',
    category: 'user_preference',
    confidence: { score: 0.7, stability: 'working' }
  },
  {
    content: 'Successful approach: Breaking complex tasks into smaller, verifiable steps improves clarity and reduces errors',
    category: 'successful_approach',
    confidence: { score: 0.85, stability: 'stable' }
  },
  {
    content: 'Pattern observed: Questions about performance often follow discussions about new features',
    category: 'recurring_topic',
    confidence: { score: 0.75, stability: 'working' }
  }
]

// ============================================================================
// PREMIUM MEMORY DUMMY DATA
// ============================================================================

// Belief status values must be lowercase to match BELIEF_STATUS enum
export const DUMMY_BELIEFS = [
  {
    content: 'TypeScript provides better maintainability than plain JavaScript for large projects',
    status: 'belief',  // lowercase!
    confidence: 0.8,
    domain: 'programming',
    evidence: [
      { type: 'OBSERVATION', content: 'IDE support significantly better with types', weight: 0.7 },
      { type: 'OBSERVATION', content: 'Refactoring is safer with compile-time checks', weight: 0.8 }
    ]
  },
  {
    content: 'Automated testing reduces bug escape rate by 40-80%',
    status: 'fact',  // lowercase!
    confidence: 0.95,
    domain: 'development',
    evidence: [
      { type: 'EXTERNAL', content: 'Multiple industry studies confirm this range', weight: 0.9 }
    ]
  },
  {
    content: 'Microservices architecture is beneficial for teams larger than 5 developers',
    status: 'hypothesis',  // lowercase!
    confidence: 0.6,
    domain: 'architecture',
    evidence: [
      { type: 'INFERENCE', content: 'Coordination overhead may outweigh benefits for small teams', weight: 0.5 }
    ]
  },
  {
    content: 'React Server Components will become the default pattern for React apps',
    status: 'assumption',  // lowercase!
    confidence: 0.7,
    domain: 'frontend',
    evidence: [
      { type: 'OBSERVATION', content: 'Next.js App Router uses RSC by default', weight: 0.6 }
    ]
  }
]

export const DUMMY_FAILURES = [
  {
    description: 'Attempted to use deprecated API endpoint without checking version',
    type: 'integration',
    severity: 'medium',
    resolution: 'Updated to v2 API with new authentication flow, added version checking',
    status: 'resolved',
    learnedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    description: 'Memory leak from unsubscribed event listeners in React component',
    type: 'performance',
    severity: 'high',
    resolution: 'Added cleanup function in useEffect return, implemented AbortController',
    status: 'resolved',
    learnedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    description: 'Database connection pool exhaustion under load',
    type: 'performance',
    severity: 'critical',
    resolution: 'Implemented connection pooling with proper limits and timeout handling',
    status: 'resolved',
    learnedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  }
]

export const DUMMY_INTENTS = [
  {
    goal: 'Improve code documentation coverage to 80%',
    level: 'tactical',
    status: 'active',
    progress: 45,
    successCriteria: [
      'JSDoc comments for all public functions',
      'README.md for each major module',
      'Architecture decision records (ADRs) for key choices'
    ]
  },
  {
    goal: 'Set up automated CI/CD pipeline',
    level: 'strategic',
    status: 'active',
    progress: 20,
    successCriteria: [
      'GitHub Actions workflow configured',
      'Automated tests run on every PR',
      'Auto-deploy to staging on merge to main'
    ]
  }
]

export const DUMMY_WORKING_SET = {
  currentFocus: {
    task: 'Exploring the memory system',
    project: 'QuoxCORE',
    goal: 'Understand how memories work'
  },
  recentEntities: [
    { type: 'file', id: 'memoryManager.js', name: 'Memory Manager Service', lastAccess: new Date().toISOString() },
    { type: 'concept', id: 'provenance', name: 'Memory Provenance System', lastAccess: new Date().toISOString() }
  ],
  openLoops: [
    { type: 'question', description: 'How do memory tiers affect feature access?', priority: 'medium' },
    { type: 'task', description: 'Review memory confirmation queue', priority: 'low' }
  ]
}

// ============================================================================
// MANAGEMENT FUNCTIONS
// ============================================================================

/**
 * Populate all dummy data into the memory system
 * @returns {Object} Stats about items added per type
 */
export function populateDummyData() {
  const timestamp = new Date().toISOString()
  const stats = { total: 0 }

  const addItems = (type, items) => {
    const key = `quox_learned_${type}`
    const existing = localStorage.getItem(key)
    let currentItems = []

    try {
      currentItems = existing ? JSON.parse(existing) : []
    } catch (e) {
      console.warn(`[DummyData] Failed to parse existing ${type} items`)
      currentItems = []
    }

    // Check if dummy data already exists for this type
    if (currentItems.some(item => item.isDummy)) {
      console.log(`[DummyData] Dummy ${type} items already exist, skipping`)
      stats[type] = 0
      return
    }

    const marker = createDummyMarker()
    const newItems = items.map((item, index) => ({
      ...item,
      ...marker,
      id: `dummy_${type}_${index}_${Date.now()}`,
      learnedAt: timestamp,
      accessCount: 0
    }))

    const combined = [...currentItems, ...newItems]
    localStorage.setItem(key, JSON.stringify(combined))

    stats[type] = newItems.length
    stats.total += newItems.length
  }

  // Populate each memory type
  addItems('preference', DUMMY_PREFERENCES)
  addItems('fact', DUMMY_FACTS)
  addItems('decision', DUMMY_DECISIONS)
  addItems('constraint', DUMMY_CONSTRAINTS)
  addItems('error', DUMMY_ERRORS)
  addItems('reflection', DUMMY_REFLECTIONS)

  console.log('[DummyData] Populated dummy memories:', stats)

  return stats
}

/**
 * Remove all dummy data from the memory system
 * @returns {number} Total items removed
 */
export function removeDummyData() {
  let totalRemoved = 0

  for (const type of MEMORY_TYPES) {
    const key = `quox_learned_${type}`
    const existing = localStorage.getItem(key)

    if (existing) {
      try {
        const items = JSON.parse(existing)
        const filtered = items.filter(item => !item.isDummy)
        const removed = items.length - filtered.length

        if (removed > 0) {
          localStorage.setItem(key, JSON.stringify(filtered))
          totalRemoved += removed
          console.log(`[DummyData] Removed ${removed} dummy ${type} items`)
        }
      } catch (e) {
        console.error(`[DummyData] Error processing ${type}:`, e)
      }
    }
  }

  console.log(`[DummyData] Total removed: ${totalRemoved} items`)
  return totalRemoved
}

/**
 * Check if any dummy data is currently present
 * @returns {boolean}
 */
export function hasDummyData() {
  for (const type of MEMORY_TYPES) {
    const key = `quox_learned_${type}`
    const existing = localStorage.getItem(key)

    if (existing) {
      try {
        const items = JSON.parse(existing)
        if (items.some(item => item.isDummy)) {
          return true
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  return false
}

/**
 * Get statistics about dummy data
 * @returns {Object} Count per type and total
 */
export function getDummyDataStats() {
  const stats = { total: 0 }

  for (const type of MEMORY_TYPES) {
    const key = `quox_learned_${type}`
    const existing = localStorage.getItem(key)

    if (existing) {
      try {
        const items = JSON.parse(existing)
        const dummyCount = items.filter(item => item.isDummy).length
        stats[type] = dummyCount
        stats.total += dummyCount
      } catch (e) {
        stats[type] = 0
      }
    } else {
      stats[type] = 0
    }
  }

  return stats
}

/**
 * Toggle dummy data on or off
 * @param {boolean} enabled - Whether to enable or disable dummy data
 * @returns {Object} Result with action taken and stats
 */
export function setDummyDataEnabled(enabled) {
  if (enabled) {
    if (hasDummyData()) {
      return { action: 'none', reason: 'already_present', stats: getDummyDataStats() }
    }
    const stats = populateDummyData()
    setUISetting('dummyDataEnabled', true)
    return { action: 'populated', stats }
  } else {
    const removed = removeDummyData()
    setUISetting('dummyDataEnabled', false)
    return { action: 'removed', count: removed }
  }
}

/**
 * Initialize dummy data system - call on app startup
 * Syncs the setting state with actual data presence
 */
export function initDummyDataSystem() {
  const settingEnabled = getUISetting('dummyDataEnabled')
  const dataPresent = hasDummyData()

  // Sync state - always try to populate/remove since each function has its own guard
  if (settingEnabled) {
    console.log('[DummyData] Setting enabled, ensuring all dummy data is present...')
    populateDummyData()
    populatePremiumDummyData()
    populateWorkingSetDummy()
  } else if (dataPresent) {
    console.log('[DummyData] Setting disabled but data present, removing...')
    removeDummyData()
    removePremiumDummyData()
    removeWorkingSetDummy()
  }

  // Subscribe to future setting changes
  const unsubscribe = subscribeToUISettings((settings) => {
    const nowEnabled = settings.dummyDataEnabled

    if (nowEnabled) {
      // Always try to populate - each function skips if data already exists
      populateDummyData()
      populatePremiumDummyData()
      populateWorkingSetDummy()
    } else {
      // Always try to remove
      removeDummyData()
      removePremiumDummyData()
      removeWorkingSetDummy()
    }
  })

  // Return unsubscribe function for cleanup if needed
  return unsubscribe
}

// ============================================================================
// PREMIUM MEMORY POPULATION (for future use)
// ============================================================================

/**
 * Populate premium memory types with dummy data
 * Call this separately if premium features are available
 */
export function populatePremiumDummyData() {
  const timestamp = new Date().toISOString()
  const marker = createDummyMarker()

  // Beliefs - must match the full belief schema from beliefMemory.js
  try {
    const beliefsKey = 'quox_beliefs'
    const existingBeliefs = localStorage.getItem(beliefsKey)
    let beliefs = existingBeliefs ? JSON.parse(existingBeliefs) : []

    if (!beliefs.some(b => b.isDummy)) {
      const dummyBeliefs = DUMMY_BELIEFS.map((b, i) => ({
        id: `dummy_belief_${i}_${Date.now()}`,
        content: b.content,
        status: b.status,  // lowercase: 'fact', 'belief', 'hypothesis', etc.
        confidence: b.confidence,
        evidence: (b.evidence || []).map((e, j) => ({
          type: e.type || 'USER_STATED',
          content: e.content,
          timestamp: timestamp,
          source: 'dummy_data',
          weight: e.weight || 0.5
        })),
        domain: b.domain || 'general',
        relatedTo: [],
        source: 'dummy_data',
        expiresAt: null,
        notes: 'Demo data - disable in Settings to remove',
        createdAt: timestamp,
        updatedAt: timestamp,
        verifiedAt: b.status === 'fact' ? timestamp : null,
        revisitCount: 0,
        history: [],
        isDummy: true
      }))
      beliefs = [...beliefs, ...dummyBeliefs]
      localStorage.setItem(beliefsKey, JSON.stringify(beliefs))
      console.log(`[DummyData] Added ${dummyBeliefs.length} dummy beliefs to quox_beliefs`)
    }
  } catch (e) {
    console.error('[DummyData] Failed to add dummy beliefs:', e)
  }

  // Failures
  try {
    const failuresKey = 'quox_failure_memory'
    const existingFailures = localStorage.getItem(failuresKey)
    let failures = existingFailures ? JSON.parse(existingFailures) : []

    if (!failures.some(f => f.isDummy)) {
      const dummyFailures = DUMMY_FAILURES.map((f, i) => ({
        ...f,
        ...marker,
        id: `dummy_failure_${i}_${Date.now()}`
      }))
      failures = [...failures, ...dummyFailures]
      localStorage.setItem(failuresKey, JSON.stringify(failures))
      console.log(`[DummyData] Added ${dummyFailures.length} dummy failures`)
    }
  } catch (e) {
    console.error('[DummyData] Failed to add dummy failures:', e)
  }

  // Intents
  try {
    const intentsKey = 'quox_intents'
    const existingIntents = localStorage.getItem(intentsKey)
    let intents = existingIntents ? JSON.parse(existingIntents) : []

    if (!intents.some(i => i.isDummy)) {
      const dummyIntents = DUMMY_INTENTS.map((intent, i) => ({
        ...intent,
        ...marker,
        id: `dummy_intent_${i}_${Date.now()}`,
        createdAt: timestamp
      }))
      intents = [...intents, ...dummyIntents]
      localStorage.setItem(intentsKey, JSON.stringify(intents))
      console.log(`[DummyData] Added ${dummyIntents.length} dummy intents`)
    }
  } catch (e) {
    console.error('[DummyData] Failed to add dummy intents:', e)
  }
}

/**
 * Remove premium memory dummy data
 */
export function removePremiumDummyData() {
  const premiumKeys = ['quox_beliefs', 'quox_failure_memory', 'quox_intents']

  for (const key of premiumKeys) {
    const existing = localStorage.getItem(key)
    if (existing) {
      try {
        const items = JSON.parse(existing)
        const filtered = items.filter(item => !item.isDummy)
        localStorage.setItem(key, JSON.stringify(filtered))
      } catch (e) {
        console.error(`[DummyData] Failed to clean ${key}:`, e)
      }
    }
  }
}

/**
 * Populate Working Set Memory with dummy data
 */
export function populateWorkingSetDummy() {
  const marker = createDummyMarker()
  const timestamp = new Date().toISOString()

  try {
    // Working Set Memory
    const wsmKey = 'quox_working_set'
    const existing = localStorage.getItem(wsmKey)

    // Check if dummy WSM already exists
    if (existing) {
      try {
        const wsm = JSON.parse(existing)
        if (wsm.isDummy) {
          console.log('[DummyData] Dummy WSM already exists, skipping')
          return
        }
      } catch (e) {}
    }

    // Create WSM in the expected format
    const dummyWSM = {
      version: 1,
      lastUpdated: timestamp,
      isDummy: true,
      currentFocus: {
        task: 'Exploring the memory system',
        project: 'QuoxCORE',
        goal: 'Understand how memories work',
        startedAt: timestamp,
        context: { isDummy: true }
      },
      activeProjects: [
        {
          id: 'dummy_project_1',
          name: 'QuoxCORE Dashboard',
          description: 'AI-powered infrastructure management system',
          status: 'active',
          lastWorkedOn: timestamp,
          priority: 'high',
          isDummy: true
        }
      ],
      recentEntities: DUMMY_WORKING_SET.recentEntities.map((e, i) => ({
        ...e,
        isDummy: true,
        id: `dummy_entity_${i}`,
        lastAccess: timestamp
      })),
      activeDecisions: [],
      painPoints: [
        {
          id: 'dummy_pain_1',
          description: 'Complex configuration management',
          severity: 'medium',
          createdAt: timestamp,
          isDummy: true
        }
      ]
    }

    localStorage.setItem(wsmKey, JSON.stringify(dummyWSM))
    console.log('[DummyData] Added dummy Working Set Memory')

    // Open Loops (separate storage)
    const loopsKey = 'quox_open_loops'
    const existingLoops = localStorage.getItem(loopsKey)
    let loops = []

    try {
      loops = existingLoops ? JSON.parse(existingLoops) : []
    } catch (e) {}

    if (!loops.some(l => l.isDummy)) {
      const dummyLoops = DUMMY_WORKING_SET.openLoops.map((l, i) => ({
        ...l,
        isDummy: true,
        id: `dummy_loop_${i}_${Date.now()}`,
        createdAt: timestamp,
        status: 'open'
      }))
      loops = [...loops, ...dummyLoops]
      localStorage.setItem(loopsKey, JSON.stringify(loops))
      console.log('[DummyData] Added dummy open loops')
    }

  } catch (e) {
    console.error('[DummyData] Failed to add dummy WSM:', e)
  }
}

/**
 * Remove Working Set Memory dummy data
 */
export function removeWorkingSetDummy() {
  // Clean WSM
  try {
    const wsmKey = 'quox_working_set'
    const wsm = localStorage.getItem(wsmKey)
    if (wsm) {
      const data = JSON.parse(wsm)
      if (data.isDummy) {
        localStorage.removeItem(wsmKey)
        console.log('[DummyData] Removed dummy WSM')
      } else {
        // Clean dummy items from arrays within WSM
        let changed = false
        if (data.recentEntities) {
          const filtered = data.recentEntities.filter(e => !e.isDummy)
          if (filtered.length !== data.recentEntities.length) {
            data.recentEntities = filtered
            changed = true
          }
        }
        if (data.activeProjects) {
          const filtered = data.activeProjects.filter(p => !p.isDummy)
          if (filtered.length !== data.activeProjects.length) {
            data.activeProjects = filtered
            changed = true
          }
        }
        if (data.painPoints) {
          const filtered = data.painPoints.filter(p => !p.isDummy)
          if (filtered.length !== data.painPoints.length) {
            data.painPoints = filtered
            changed = true
          }
        }
        if (changed) {
          localStorage.setItem(wsmKey, JSON.stringify(data))
          console.log('[DummyData] Cleaned dummy items from WSM')
        }
      }
    }
  } catch (e) {
    console.error('[DummyData] Failed to clean WSM:', e)
  }

  // Clean open loops
  try {
    const loopsKey = 'quox_open_loops'
    const loops = localStorage.getItem(loopsKey)
    if (loops) {
      const data = JSON.parse(loops)
      if (Array.isArray(data)) {
        const filtered = data.filter(item => !item.isDummy)
        if (filtered.length !== data.length) {
          localStorage.setItem(loopsKey, JSON.stringify(filtered))
          console.log('[DummyData] Cleaned dummy open loops')
        }
      }
    }
  } catch (e) {
    console.error('[DummyData] Failed to clean open loops:', e)
  }
}

/**
 * Force repopulate all dummy data (removes existing and re-adds)
 * Useful for debugging or updating dummy data format
 */
export function forceRepopulateDummyData() {
  console.log('[DummyData] Force repopulating all dummy data...')

  // Remove all existing dummy data first
  removeDummyData()
  removePremiumDummyData()
  removeWorkingSetDummy()

  // Re-populate everything
  const basicStats = populateDummyData()
  populatePremiumDummyData()
  populateWorkingSetDummy()

  console.log('[DummyData] Force repopulate complete:', basicStats)
  return basicStats
}

export default {
  populateDummyData,
  removeDummyData,
  hasDummyData,
  getDummyDataStats,
  setDummyDataEnabled,
  initDummyDataSystem,
  populatePremiumDummyData,
  removePremiumDummyData,
  populateWorkingSetDummy,
  removeWorkingSetDummy,
  forceRepopulateDummyData,
  // Export data definitions for testing/inspection
  DUMMY_PREFERENCES,
  DUMMY_FACTS,
  DUMMY_DECISIONS,
  DUMMY_CONSTRAINTS,
  DUMMY_ERRORS,
  DUMMY_REFLECTIONS,
  DUMMY_BELIEFS,
  DUMMY_FAILURES,
  DUMMY_INTENTS,
  DUMMY_WORKING_SET
}
