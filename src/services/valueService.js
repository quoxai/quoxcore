/**
 * QuoxValue Service — Priority Intelligence
 *
 * Inspired by the orbitofrontal cortex. Assigns importance, relevance,
 * and priority to competing concerns.
 *
 * Stream QMB Phase QMB-4.
 *
 * Combines:
 * - Capability index stats (tools, workflows, agents)
 * - Signal priority scoring
 * - Active concern tracking
 */

import { getRecentSignals, getSignalBreakdown } from './senseService.js'

// ── Priority Queue ─────────────────────────────────────────────────
// Tracks active concerns with priority scores.

const MAX_CONCERNS = 50
const concerns = []

/**
 * Register an active concern with a priority score.
 * @param {string} source — what raised the concern
 * @param {string} description — what the concern is
 * @param {number} priority — 0 (low) to 100 (critical)
 * @param {Object} [metadata]
 */
export function raiseConcern(source, description, priority, metadata = null) {
  const concern = {
    source,
    description,
    priority: Math.max(0, Math.min(100, priority)),
    metadata,
    raisedAt: Date.now(),
    resolved: false,
  }

  concerns.push(concern)

  // Trim oldest low-priority concerns
  if (concerns.length > MAX_CONCERNS) {
    concerns.sort((a, b) => b.priority - a.priority)
    concerns.length = MAX_CONCERNS
  }

  return concern
}

/**
 * Resolve a concern (mark as handled).
 * @param {string} description — match by description
 * @returns {boolean} true if found and resolved
 */
export function resolveConcern(description) {
  const idx = concerns.findIndex(c => c.description === description && !c.resolved)
  if (idx >= 0) {
    concerns[idx].resolved = true
    concerns[idx].resolvedAt = Date.now()
    return true
  }
  return false
}

/**
 * Get active (unresolved) concerns sorted by priority.
 * @returns {Array}
 */
export function getActiveConcerns() {
  return concerns
    .filter(c => !c.resolved)
    .sort((a, b) => b.priority - a.priority)
}

/**
 * Get priority distribution of recent signals.
 * Assigns priority scores based on signal type.
 * @returns {Object} { high: N, medium: N, low: N }
 */
export function getSignalPriorityDistribution() {
  const signals = getRecentSignals(3600000) // last hour
  const distribution = { high: 0, medium: 0, low: 0 }

  for (const signal of signals) {
    switch (signal.type) {
      case 'error':
        distribution.high++
        break
      case 'health':
        if (signal.data?.change === 'degraded') distribution.high++
        else distribution.medium++
        break
      case 'execution':
        distribution.medium++
        break
      case 'memory':
      case 'agent':
      default:
        distribution.low++
        break
    }
  }

  return distribution
}

/**
 * Get QuoxValue implant metrics.
 * Combines capability stats with priority intelligence.
 */
export function getValueStats(capabilityStats) {
  const activeConcerns = getActiveConcerns()
  const priorityDist = getSignalPriorityDistribution()
  const breakdown = getSignalBreakdown()

  return {
    // Pass through capability stats as the primary metric
    totalCapabilities: capabilityStats?.totalEntities || 0,
    assistants: capabilityStats?.assistants || 0,
    tools: capabilityStats?.tools || 0,
    workflows: capabilityStats?.workflows || 0,
    // Priority intelligence additions
    activeConcerns: activeConcerns.length,
    highPriority: priorityDist.high,
    mediumPriority: priorityDist.medium,
    lowPriority: priorityDist.low,
    topConcern: activeConcerns[0]?.description || null,
  }
}
