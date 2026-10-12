/**
 * Quox Failure Memory
 *
 * Tracks what DIDN'T work and WHY. This is critical for:
 * - Preventing repeated mistakes
 * - Learning from errors
 * - Building institutional knowledge about what to avoid
 *
 * Key insight: Remembering failures is as important as remembering successes.
 * Without failure memory, Quox would suggest the same broken approaches
 * repeatedly.
 *
 * Categories of failures:
 * - Command failures (things that errored)
 * - Approach failures (strategies that didn't work)
 * - Configuration failures (settings that caused problems)
 * - Integration failures (things that don't work together)
 * - Performance failures (things that were too slow/resource-intensive)
 * - User rejected (user said no to this)
 *
 * TIERED: Failure Memory is a Premium feature
 */

import { ulid } from '../lib/aee/ulid'
import { hasFeature, createUpgradePrompt } from './memoryTier'

// ============================================================================
// TIER GATING
// ============================================================================

/**
 * Check if Failure Memory is available (Premium only)
 * @returns {{ available: boolean, upgrade?: object }}
 */
export function isFailureMemoryAvailable() {
  const available = hasFeature('hasFailureMemory')
  if (!available) {
    return {
      available: false,
      upgrade: createUpgradePrompt('failureMemory')
    }
  }
  return { available: true }
}

/**
 * Tier-gated wrapper - returns blocked response if not premium
 */
function requirePremiumOr(defaultReturn) {
  if (!hasFeature('hasFailureMemory')) {
    return { blocked: true, reason: 'premium_required', upgrade: createUpgradePrompt('failureMemory'), ...defaultReturn }
  }
  return null
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const FAILURE_TYPES = {
  COMMAND: 'command',           // A specific command that failed
  APPROACH: 'approach',         // A strategy or approach that didn't work
  CONFIGURATION: 'configuration', // A config that caused problems
  INTEGRATION: 'integration',   // Two things that don't work together
  PERFORMANCE: 'performance',   // Too slow, too many resources
  COMPATIBILITY: 'compatibility', // Version/system incompatibility
  SECURITY: 'security',         // Security issue discovered
  USER_REJECTED: 'user_rejected', // User explicitly said no
  TIMEOUT: 'timeout',           // Operation timed out
  DEPENDENCY: 'dependency',     // Missing or broken dependency
  PERMISSION: 'permission',     // Access/permission issue
  OTHER: 'other'
}

export const FAILURE_SEVERITY = {
  CRITICAL: 'critical',     // System-breaking, never try again
  HIGH: 'high',             // Significant failure, strong warning
  MEDIUM: 'medium',         // Notable failure, suggest alternative
  LOW: 'low',               // Minor issue, mention but don't block
  INFORMATIONAL: 'info'     // Just noting it didn't work great
}

export const FAILURE_STATUS = {
  ACTIVE: 'active',         // Still a problem
  RESOLVED: 'resolved',     // Fixed, but keep the record
  WORKAROUND: 'workaround', // There's a workaround
  OUTDATED: 'outdated',     // May no longer apply
  SUPERSEDED: 'superseded'  // Replaced by another failure record
}

// ============================================================================
// STORAGE
// ============================================================================

import { personalGet, personalSet } from './orgScopedStorage'
import { getMemoryClient } from './memoryClient'

// QMH2-CONSOLIDATION: failure memory used to also auto-sync to auth-service
// preferences JSON (org_memberships.preferences_json, via personalSet's
// ORG_NAMESPACE_MAP lookup) — the WRONG store. It now write-throughs to the
// memory service's identity_blobs store (namespace 'failures') instead; the
// auth-prefs duplication (ORG_NAMESPACE_MAP 'failure-mem' entry) is retired.
const memoryClient = getMemoryClient()
const FAILURES_NAMESPACE = 'failures'

function loadFailures() {
  try {
    const stored = personalGet('failure-mem')
    return stored ? JSON.parse(stored) : []
  } catch (e) {
    console.error('Error loading failure memory:', e)
    return []
  }
}

function saveFailures(failures) {
  try {
    personalSet('failure-mem', JSON.stringify(failures))
    _failuresWriteThrough(failures)
  } catch (e) {
    console.error('Error saving failure memory:', e)
  }
}

function _failuresWriteThrough(failures) {
  try {
    memoryClient.setIdentity(FAILURES_NAMESPACE, failures).catch(err => {
      console.warn('[FailureMemory] Identity write-through failed:', err.message)
    })
  } catch (err) {
    console.warn('[FailureMemory] Identity write-through error:', err.message)
  }
}

/**
 * Hydrate the org-scoped failure-mem local cache from the memory service.
 *
 * Failures' local cache key is dynamic (quox_{org}_{user}_failure-mem) so it
 * is NOT covered by memoryManager.hydrateIdentityFromServer(). Must be
 * called AFTER setStorageContext(org, user) is set — call once on auth and
 * again on every 'quox-org-switch' so switching orgs hydrates the newly-
 * selected org's blob. Never overwrites an existing local cache; best-effort.
 */
export async function hydrateFailuresFromServer() {
  try {
    if (personalGet('failure-mem')) return
    const result = await memoryClient.getIdentity(FAILURES_NAMESPACE)
    if (result && Array.isArray(result.data)) {
      personalSet('failure-mem', JSON.stringify(result.data))
    }
  } catch (err) {
    console.warn('[FailureMemory] Identity hydration failed:', err.message)
  }
}

// ============================================================================
// FAILURE RECORDING
// ============================================================================

/**
 * Record a failure
 * TIERED: Premium only
 */
export function recordFailure({
  type,
  description,
  severity = FAILURE_SEVERITY.MEDIUM,
  context = {},
  whatFailed,
  whyItFailed = null,
  whatWeTriedInstead = null,
  affectedEntities = [],
  affectedDomains = [],
  errorMessage = null,
  errorCode = null,
  stackTrace = null,
  reproductionSteps = [],
  avoidanceAdvice = null,
  suggestedAlternatives = [],
  relatedTo = [],
  tags = []
}) {
  // TIER CHECK: Failure memory requires Premium
  const blocked = requirePremiumOr({ failure: null })
  if (blocked) return blocked

  const failures = loadFailures()

  const failure = {
    id: ulid(),
    type,
    description,
    severity,
    status: FAILURE_STATUS.ACTIVE,

    // What happened
    whatFailed,
    whyItFailed,
    whatWeTriedInstead,
    errorMessage,
    errorCode,
    stackTrace,

    // Context
    context: {
      ...context,
      recordedAt: new Date().toISOString()
    },
    reproductionSteps,

    // Impact
    affectedEntities,
    affectedDomains,

    // Learning
    avoidanceAdvice,
    suggestedAlternatives,
    lessonsLearned: [],

    // Metadata
    relatedTo,
    tags,
    occurrenceCount: 1,
    lastOccurrence: new Date().toISOString(),
    firstOccurrence: new Date().toISOString(),

    // Resolution
    resolvedAt: null,
    resolution: null,
    workaround: null,

    // Timestamps
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }

  // Check for similar existing failures and increment count
  const similar = findSimilarFailure(failures, failure)
  if (similar) {
    similar.occurrenceCount++
    similar.lastOccurrence = new Date().toISOString()
    similar.updatedAt = new Date().toISOString()

    // Update if this has more detail
    if (whyItFailed && !similar.whyItFailed) {
      similar.whyItFailed = whyItFailed
    }
    if (errorMessage && !similar.errorMessage) {
      similar.errorMessage = errorMessage
    }

    saveFailures(failures)
    return similar
  }

  failures.push(failure)
  saveFailures(failures)

  return failure
}

/**
 * Find a similar existing failure
 */
function findSimilarFailure(failures, newFailure) {
  return failures.find(f => {
    if (f.type !== newFailure.type) return false
    if (f.status !== FAILURE_STATUS.ACTIVE) return false

    // Same error message is a strong signal
    if (f.errorMessage && newFailure.errorMessage &&
        f.errorMessage === newFailure.errorMessage) {
      return true
    }

    // Same whatFailed is also a strong signal
    if (f.whatFailed && newFailure.whatFailed) {
      const similarity = calculateSimilarity(f.whatFailed, newFailure.whatFailed)
      if (similarity > 0.8) return true
    }

    return false
  })
}

/**
 * Simple similarity calculation for strings
 */
function calculateSimilarity(str1, str2) {
  const s1 = str1.toLowerCase()
  const s2 = str2.toLowerCase()

  if (s1 === s2) return 1.0

  const words1 = new Set(s1.split(/\s+/))
  const words2 = new Set(s2.split(/\s+/))

  const intersection = [...words1].filter(w => words2.has(w)).length
  const union = new Set([...words1, ...words2]).size

  return intersection / union
}

/**
 * Record a command failure specifically
 */
export function recordCommandFailure({
  command,
  host = null,
  exitCode = null,
  errorOutput = null,
  context = {},
  suggestedFix = null
}) {
  return recordFailure({
    type: FAILURE_TYPES.COMMAND,
    description: `Command failed: ${command}`,
    whatFailed: command,
    whyItFailed: errorOutput,
    errorCode: exitCode,
    errorMessage: errorOutput,
    affectedEntities: host ? [host] : [],
    context: { ...context, host, command },
    avoidanceAdvice: suggestedFix,
    tags: ['command', host].filter(Boolean)
  })
}

/**
 * Record when user rejects a suggestion
 */
export function recordUserRejection({
  suggestion,
  reason = null,
  context = {},
  alternative = null
}) {
  return recordFailure({
    type: FAILURE_TYPES.USER_REJECTED,
    description: `User rejected: ${suggestion}`,
    severity: FAILURE_SEVERITY.MEDIUM,
    whatFailed: suggestion,
    whyItFailed: reason || 'User preference',
    whatWeTriedInstead: alternative,
    context,
    avoidanceAdvice: `Don't suggest "${suggestion}" - user has rejected this approach`,
    tags: ['user_preference', 'rejected']
  })
}

/**
 * Record an approach that didn't work
 */
export function recordApproachFailure({
  approach,
  problem,
  whyFailed,
  betterApproach = null,
  context = {},
  affectedDomains = []
}) {
  return recordFailure({
    type: FAILURE_TYPES.APPROACH,
    description: `Approach failed: ${approach}`,
    whatFailed: approach,
    whyItFailed: whyFailed,
    whatWeTriedInstead: betterApproach,
    suggestedAlternatives: betterApproach ? [betterApproach] : [],
    affectedDomains,
    context: { ...context, problem },
    avoidanceAdvice: `Avoid approach: ${approach}. ${whyFailed}`,
    tags: ['approach', ...affectedDomains]
  })
}

// ============================================================================
// FAILURE RESOLUTION
// ============================================================================

/**
 * Mark a failure as resolved
 */
export function resolveFailure(failureId, {
  resolution,
  fixApplied = null,
  preventionMeasures = []
}) {
  const failures = loadFailures()
  const idx = failures.findIndex(f => f.id === failureId)

  if (idx === -1) return null

  const failure = failures[idx]
  failure.status = FAILURE_STATUS.RESOLVED
  failure.resolvedAt = new Date().toISOString()
  failure.resolution = resolution
  failure.fixApplied = fixApplied
  failure.preventionMeasures = preventionMeasures
  failure.updatedAt = new Date().toISOString()

  failures[idx] = failure
  saveFailures(failures)

  return failure
}

/**
 * Add a workaround to a failure
 */
export function addWorkaround(failureId, {
  workaround,
  caveats = [],
  temporary = true
}) {
  const failures = loadFailures()
  const idx = failures.findIndex(f => f.id === failureId)

  if (idx === -1) return null

  const failure = failures[idx]
  failure.status = FAILURE_STATUS.WORKAROUND
  failure.workaround = {
    description: workaround,
    caveats,
    temporary,
    addedAt: new Date().toISOString()
  }
  failure.updatedAt = new Date().toISOString()

  failures[idx] = failure
  saveFailures(failures)

  return failure
}

/**
 * Add lessons learned to a failure
 */
export function addLessonsLearned(failureId, lessons) {
  const failures = loadFailures()
  const idx = failures.findIndex(f => f.id === failureId)

  if (idx === -1) return null

  const failure = failures[idx]
  failure.lessonsLearned = [
    ...failure.lessonsLearned,
    ...lessons.map(l => ({
      content: l,
      addedAt: new Date().toISOString()
    }))
  ]
  failure.updatedAt = new Date().toISOString()

  failures[idx] = failure
  saveFailures(failures)

  return failure
}

// ============================================================================
// FAILURE RETRIEVAL
// ============================================================================

/**
 * Get all failures
 */
export function getAllFailures(options = {}) {
  const { includeResolved = false, type = null, severity = null } = options
  let failures = loadFailures()

  if (!includeResolved) {
    failures = failures.filter(f => f.status === FAILURE_STATUS.ACTIVE ||
                                     f.status === FAILURE_STATUS.WORKAROUND)
  }

  if (type) {
    failures = failures.filter(f => f.type === type)
  }

  if (severity) {
    failures = failures.filter(f => f.severity === severity)
  }

  return failures.sort((a, b) => new Date(b.lastOccurrence) - new Date(a.lastOccurrence))
}

/**
 * Get failures by entity (host, service, etc.)
 */
export function getFailuresByEntity(entity) {
  const failures = loadFailures()
  return failures.filter(f =>
    f.affectedEntities.includes(entity) ||
    f.relatedTo.includes(entity)
  )
}

/**
 * Get failures by domain
 */
export function getFailuresByDomain(domain) {
  const failures = loadFailures()
  return failures.filter(f => f.affectedDomains.includes(domain))
}

/**
 * Get recent failures
 */
export function getRecentFailures(options = {}) {
  const { hours = 24, limit = 10 } = options
  const cutoff = Date.now() - (hours * 60 * 60 * 1000)
  const failures = loadFailures()

  return failures
    .filter(f => new Date(f.lastOccurrence).getTime() > cutoff)
    .sort((a, b) => new Date(b.lastOccurrence) - new Date(a.lastOccurrence))
    .slice(0, limit)
}

/**
 * Get frequent failures (recurring problems)
 */
export function getFrequentFailures(options = {}) {
  const { minOccurrences = 3, limit = 10 } = options
  const failures = loadFailures()

  return failures
    .filter(f => f.occurrenceCount >= minOccurrences)
    .filter(f => f.status === FAILURE_STATUS.ACTIVE)
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
    .slice(0, limit)
}

/**
 * Find failures relevant to a query or context
 */
export function findRelevantFailures(query, options = {}) {
  const { includeResolved = false, limit = 5 } = options
  const failures = loadFailures()
  const queryLower = query.toLowerCase()
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2)

  return failures
    .filter(f => includeResolved ||
                 f.status === FAILURE_STATUS.ACTIVE ||
                 f.status === FAILURE_STATUS.WORKAROUND)
    .map(f => {
      let score = 0

      // Match against whatFailed
      const whatFailedLower = (f.whatFailed || '').toLowerCase()
      queryWords.forEach(word => {
        if (whatFailedLower.includes(word)) score += 2
      })

      // Match against description
      const descLower = f.description.toLowerCase()
      queryWords.forEach(word => {
        if (descLower.includes(word)) score += 1
      })

      // Match against entities
      f.affectedEntities.forEach(entity => {
        if (queryLower.includes(entity.toLowerCase())) score += 3
      })

      // Match against tags
      f.tags.forEach(tag => {
        if (queryLower.includes(tag.toLowerCase())) score += 2
      })

      // Severity boost
      const severityBoost = {
        [FAILURE_SEVERITY.CRITICAL]: 2.0,
        [FAILURE_SEVERITY.HIGH]: 1.5,
        [FAILURE_SEVERITY.MEDIUM]: 1.0,
        [FAILURE_SEVERITY.LOW]: 0.7,
        [FAILURE_SEVERITY.INFORMATIONAL]: 0.5
      }
      score *= (severityBoost[f.severity] || 1.0)

      // Recency boost (more recent = more relevant)
      const daysSince = (Date.now() - new Date(f.lastOccurrence).getTime()) / (1000 * 60 * 60 * 24)
      const recencyBoost = Math.max(0.5, 1 - (daysSince / 30))
      score *= recencyBoost

      // Frequency boost
      if (f.occurrenceCount > 1) {
        score *= (1 + Math.log10(f.occurrenceCount))
      }

      return { ...f, relevanceScore: score }
    })
    .filter(f => f.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, limit)
}

/**
 * Check if something has failed before
 */
export function hasFailedBefore(whatToCheck, options = {}) {
  const { threshold = 0.7 } = options
  const failures = loadFailures()

  for (const f of failures) {
    if (f.status !== FAILURE_STATUS.ACTIVE && f.status !== FAILURE_STATUS.WORKAROUND) {
      continue
    }

    const similarity = calculateSimilarity(whatToCheck, f.whatFailed || '')
    if (similarity >= threshold) {
      return {
        hasFailedBefore: true,
        previousFailure: f,
        similarity,
        advice: f.avoidanceAdvice,
        workaround: f.workaround,
        alternatives: f.suggestedAlternatives
      }
    }
  }

  return { hasFailedBefore: false }
}

// ============================================================================
// CONTEXT GENERATION
// ============================================================================

/**
 * Generate failure context for prompt injection
 * TIERED: Requires Advanced Memory Plugin - returns empty context for free version
 */
export function generateFailureContext(query, options = {}) {
  // TIER CHECK: Failure context requires Advanced Memory Plugin
  if (!hasFeature('hasFailureMemory')) {
    return { context: '', estimatedTokens: 0, withinBudget: true }
  }

  const { maxTokens = 300 } = options

  const lines = []
  let estimatedTokens = 0
  const tokensPerLine = 15

  // Find relevant failures
  const relevant = findRelevantFailures(query, { limit: 5 })

  if (relevant.length === 0) {
    return { context: '', estimatedTokens: 0, withinBudget: true }
  }

  lines.push('### Known Issues & Past Failures')
  lines.push('')

  // Critical/high severity first
  const critical = relevant.filter(f =>
    f.severity === FAILURE_SEVERITY.CRITICAL ||
    f.severity === FAILURE_SEVERITY.HIGH
  )

  if (critical.length > 0) {
    lines.push('**Warnings:**')
    critical.forEach(f => {
      lines.push(`- ${f.whatFailed}: ${f.whyItFailed || f.description}`)
      if (f.avoidanceAdvice) {
        lines.push(`  → ${f.avoidanceAdvice}`)
      }
      if (f.workaround) {
        lines.push(`  → Workaround: ${f.workaround.description}`)
      }
    })
    lines.push('')
  }

  estimatedTokens = lines.length * tokensPerLine
  if (estimatedTokens >= maxTokens) {
    return { context: lines.join('\n'), estimatedTokens, withinBudget: true }
  }

  // Other relevant failures
  const others = relevant.filter(f =>
    f.severity !== FAILURE_SEVERITY.CRITICAL &&
    f.severity !== FAILURE_SEVERITY.HIGH
  )

  if (others.length > 0) {
    lines.push('**Notes:**')
    others.slice(0, 3).forEach(f => {
      lines.push(`- ${f.whatFailed}: ${f.avoidanceAdvice || f.description}`)
    })
    lines.push('')
  }

  // Frequent failures as general warnings
  const frequent = getFrequentFailures({ minOccurrences: 3, limit: 2 })
  const relevantFrequent = frequent.filter(f =>
    !relevant.find(r => r.id === f.id)
  )

  estimatedTokens = lines.length * tokensPerLine
  if (estimatedTokens < maxTokens && relevantFrequent.length > 0) {
    lines.push('**Recurring issues:**')
    relevantFrequent.forEach(f => {
      lines.push(`- ${f.whatFailed} (${f.occurrenceCount}x)`)
    })
  }

  const context = lines.join('\n')
  estimatedTokens = lines.length * tokensPerLine

  return {
    context,
    estimatedTokens,
    withinBudget: estimatedTokens <= maxTokens,
    failuresFound: relevant.length
  }
}

/**
 * Get warnings for a specific action
 */
export function getWarningsForAction(action, entities = []) {
  const warnings = []

  // Check if this specific action has failed
  const check = hasFailedBefore(action)
  if (check.hasFailedBefore) {
    warnings.push({
      type: 'previous_failure',
      severity: check.previousFailure.severity,
      message: `This has failed before: ${check.previousFailure.whyItFailed || check.previousFailure.description}`,
      advice: check.advice,
      workaround: check.workaround,
      alternatives: check.alternatives
    })
  }

  // Check failures related to entities
  entities.forEach(entity => {
    const entityFailures = getFailuresByEntity(entity)
      .filter(f => f.status === FAILURE_STATUS.ACTIVE)
    entityFailures.forEach(f => {
      if (f.severity === FAILURE_SEVERITY.CRITICAL ||
          f.severity === FAILURE_SEVERITY.HIGH) {
        warnings.push({
          type: 'entity_issue',
          severity: f.severity,
          entity,
          message: f.description,
          advice: f.avoidanceAdvice
        })
      }
    })
  })

  return warnings
}

/**
 * Get failure summary statistics
 */
export function getFailureSummary() {
  const failures = loadFailures()

  return {
    total: failures.length,
    active: failures.filter(f => f.status === FAILURE_STATUS.ACTIVE).length,
    resolved: failures.filter(f => f.status === FAILURE_STATUS.RESOLVED).length,
    withWorkaround: failures.filter(f => f.status === FAILURE_STATUS.WORKAROUND).length,
    byType: Object.values(FAILURE_TYPES).reduce((acc, type) => {
      acc[type] = failures.filter(f => f.type === type).length
      return acc
    }, {}),
    bySeverity: Object.values(FAILURE_SEVERITY).reduce((acc, sev) => {
      acc[sev] = failures.filter(f => f.severity === sev).length
      return acc
    }, {}),
    frequentFailures: getFrequentFailures({ minOccurrences: 2 }).length,
    recentFailures: getRecentFailures({ hours: 24 }).length
  }
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Mark old resolved failures as outdated
 */
export function cleanupOldFailures(options = {}) {
  const { daysOld = 90 } = options
  const cutoff = Date.now() - (daysOld * 24 * 60 * 60 * 1000)
  const failures = loadFailures()
  let cleaned = 0

  failures.forEach(f => {
    if (f.status === FAILURE_STATUS.RESOLVED &&
        new Date(f.resolvedAt).getTime() < cutoff) {
      f.status = FAILURE_STATUS.OUTDATED
      cleaned++
    }
  })

  if (cleaned > 0) {
    saveFailures(failures)
  }

  return { cleaned }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  // Tier Gating
  isFailureMemoryAvailable,

  // Recording (Premium)
  recordFailure,
  recordCommandFailure,
  recordUserRejection,
  recordApproachFailure,

  // Resolution (Premium)
  resolveFailure,
  addWorkaround,
  addLessonsLearned,

  // Retrieval (Premium)
  getAllFailures,
  getFailuresByEntity,
  getFailuresByDomain,
  getRecentFailures,
  getFrequentFailures,
  findRelevantFailures,
  hasFailedBefore,

  // Context (Premium)
  generateFailureContext,
  getWarningsForAction,
  getFailureSummary,

  // Cleanup
  cleanupOldFailures,

  // Server hydration (QMH2-CONSOLIDATION)
  hydrateFailuresFromServer,

  // Constants
  FAILURE_TYPES,
  FAILURE_SEVERITY,
  FAILURE_STATUS
}
