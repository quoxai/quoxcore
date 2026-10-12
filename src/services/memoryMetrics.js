/**
 * Quox Memory Metrics Service
 *
 * Collects and analyzes memory system performance metrics.
 * Part of Wave 4 Memory Overhaul - "giggly-seeking-beacon"
 */

import { getMemoryManager } from './memoryManager.js'

// ============================================================================
// METRIC DEFINITIONS
// ============================================================================

/**
 * Core memory metrics
 */
export const METRIC_DEFINITIONS = {
  // Correctness metrics
  recallAccuracy: {
    name: 'Recall Accuracy',
    description: 'Correct memories retrieved / Total queries',
    unit: 'percentage',
    target: 0.9
  },
  contradictionRate: {
    name: 'Contradiction Rate',
    description: 'Conflicts detected / Total memories',
    unit: 'percentage',
    target: 0.05,
    lowerIsBetter: true
  },

  // Relevance metrics
  contextRelevance: {
    name: 'Context Relevance',
    description: 'Average relevance score of injected context',
    unit: 'score',
    target: 0.8
  },
  noiseRatio: {
    name: 'Noise Ratio',
    description: 'Irrelevant context / Total context',
    unit: 'percentage',
    target: 0.1,
    lowerIsBetter: true
  },

  // Continuity metrics
  sessionContinuity: {
    name: 'Session Continuity',
    description: 'Successful topic resumptions',
    unit: 'count',
    target: null
  },
  identityStability: {
    name: 'Identity Stability',
    description: 'Consistent user recognition rate',
    unit: 'percentage',
    target: 1.0
  },

  // Performance metrics
  retrievalLatency: {
    name: 'Retrieval Latency',
    description: 'Time to retrieve relevant memories',
    unit: 'ms',
    target: 100,
    lowerIsBetter: true
  },
  memoryGrowth: {
    name: 'Memory Growth',
    description: 'New items per day',
    unit: 'count/day',
    target: null
  },

  // Health metrics
  totalMemories: {
    name: 'Total Memories',
    description: 'Total items stored',
    unit: 'count',
    target: null
  },
  memoryByType: {
    name: 'Memories by Type',
    description: 'Distribution across memory types',
    unit: 'distribution',
    target: null
  },
  confirmationRate: {
    name: 'Confirmation Rate',
    description: 'Memories requiring user confirmation',
    unit: 'percentage',
    target: 0.2
  }
}

// ============================================================================
// METRICS COLLECTION
// ============================================================================

// In-memory metrics store
const metricsStore = {
  queries: [],
  retrievals: [],
  confirmations: [],
  contradictions: [],
  sessions: []
}

// Maximum history to keep
const MAX_HISTORY = 1000

/**
 * Record a query and its retrieval results
 */
export function recordQuery(query, results, options = {}) {
  const {
    latencyMs = 0,
    relevanceScores = [],
    hadCorrectMemory = null,
    userId = null
  } = options

  const record = {
    id: `query_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    timestamp: new Date().toISOString(),
    query: query.substring(0, 200),
    resultCount: results.length,
    latencyMs,
    avgRelevance: relevanceScores.length > 0
      ? relevanceScores.reduce((a, b) => a + b, 0) / relevanceScores.length
      : null,
    hadCorrectMemory,
    userId
  }

  metricsStore.queries.push(record)

  // Trim history
  if (metricsStore.queries.length > MAX_HISTORY) {
    metricsStore.queries = metricsStore.queries.slice(-MAX_HISTORY)
  }

  return record
}

/**
 * Record a memory retrieval operation
 */
export function recordRetrieval(options) {
  const {
    type = 'hybrid',
    count = 0,
    latencyMs = 0,
    vectorHits = 0,
    keywordHits = 0
  } = options

  const record = {
    id: `retrieval_${Date.now()}`,
    timestamp: new Date().toISOString(),
    type,
    count,
    latencyMs,
    vectorHits,
    keywordHits
  }

  metricsStore.retrievals.push(record)

  if (metricsStore.retrievals.length > MAX_HISTORY) {
    metricsStore.retrievals = metricsStore.retrievals.slice(-MAX_HISTORY)
  }

  return record
}

/**
 * Record a confirmation event
 */
export function recordConfirmation(options) {
  const {
    memoryId,
    action = 'approved', // approved | rejected | edited
    reason = null,
    waitTimeMs = 0
  } = options

  const record = {
    id: `confirm_${Date.now()}`,
    timestamp: new Date().toISOString(),
    memoryId,
    action,
    reason,
    waitTimeMs
  }

  metricsStore.confirmations.push(record)

  if (metricsStore.confirmations.length > MAX_HISTORY) {
    metricsStore.confirmations = metricsStore.confirmations.slice(-MAX_HISTORY)
  }

  return record
}

/**
 * Record a contradiction detection
 */
export function recordContradiction(options) {
  const {
    memory1Id,
    memory2Id,
    similarity = 0,
    resolution = 'pending',
    autoResolved = false
  } = options

  const record = {
    id: `contradiction_${Date.now()}`,
    timestamp: new Date().toISOString(),
    memory1Id,
    memory2Id,
    similarity,
    resolution,
    autoResolved
  }

  metricsStore.contradictions.push(record)

  if (metricsStore.contradictions.length > MAX_HISTORY) {
    metricsStore.contradictions = metricsStore.contradictions.slice(-MAX_HISTORY)
  }

  return record
}

/**
 * Record session continuity
 */
export function recordSession(options) {
  const {
    userId,
    resumed = false,
    topicMatched = false,
    identityRecognized = true
  } = options

  const record = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    userId,
    resumed,
    topicMatched,
    identityRecognized
  }

  metricsStore.sessions.push(record)

  if (metricsStore.sessions.length > MAX_HISTORY) {
    metricsStore.sessions = metricsStore.sessions.slice(-MAX_HISTORY)
  }

  return record
}

// ============================================================================
// METRICS CALCULATION
// ============================================================================

/**
 * Calculate all metrics for a time range
 */
export function calculateMetrics(options = {}) {
  const {
    since = Date.now() - 24 * 60 * 60 * 1000, // Last 24 hours
    until = Date.now()
  } = options

  const sinceDate = new Date(since).toISOString()
  const untilDate = new Date(until).toISOString()

  // Filter records by time range
  const queries = metricsStore.queries.filter(
    r => r.timestamp >= sinceDate && r.timestamp <= untilDate
  )
  const retrievals = metricsStore.retrievals.filter(
    r => r.timestamp >= sinceDate && r.timestamp <= untilDate
  )
  const confirmations = metricsStore.confirmations.filter(
    r => r.timestamp >= sinceDate && r.timestamp <= untilDate
  )
  const contradictions = metricsStore.contradictions.filter(
    r => r.timestamp >= sinceDate && r.timestamp <= untilDate
  )
  const sessions = metricsStore.sessions.filter(
    r => r.timestamp >= sinceDate && r.timestamp <= untilDate
  )

  // Get memory stats
  const mm = getMemoryManager()
  const memoryStats = getMemoryStats(mm)

  return {
    timeRange: { since: sinceDate, until: untilDate },

    // Correctness
    recallAccuracy: calculateRecallAccuracy(queries),
    contradictionRate: calculateContradictionRate(contradictions, memoryStats.total),

    // Relevance
    contextRelevance: calculateAvgRelevance(queries),
    noiseRatio: calculateNoiseRatio(queries),

    // Continuity
    sessionContinuity: calculateSessionContinuity(sessions),
    identityStability: calculateIdentityStability(sessions),

    // Performance
    retrievalLatency: calculateLatencyStats(retrievals),
    memoryGrowth: calculateGrowthRate(memoryStats, since, until),

    // Health
    totalMemories: memoryStats.total,
    memoryByType: memoryStats.byType,
    confirmationRate: calculateConfirmationRate(confirmations),
    confirmationStats: calculateConfirmationStats(confirmations),

    // Raw counts
    counts: {
      queries: queries.length,
      retrievals: retrievals.length,
      confirmations: confirmations.length,
      contradictions: contradictions.length,
      sessions: sessions.length
    }
  }
}

/**
 * Get memory statistics from manager
 */
function getMemoryStats(mm) {
  const types = ['fact', 'preference', 'constraint', 'decision', 'error', 'reflection', 'intent']
  const byType = {}
  let total = 0

  for (const type of types) {
    const items = mm.getLearnedItemsByType(type)
    byType[type] = items.length
    total += items.length
  }

  return { total, byType }
}

/**
 * Calculate recall accuracy from queries with feedback
 */
function calculateRecallAccuracy(queries) {
  const withFeedback = queries.filter(q => q.hadCorrectMemory !== null)
  if (withFeedback.length === 0) return null

  const correct = withFeedback.filter(q => q.hadCorrectMemory).length
  return correct / withFeedback.length
}

/**
 * Calculate contradiction rate
 */
function calculateContradictionRate(contradictions, totalMemories) {
  if (totalMemories === 0) return 0
  return contradictions.length / totalMemories
}

/**
 * Calculate average relevance score
 */
function calculateAvgRelevance(queries) {
  const withRelevance = queries.filter(q => q.avgRelevance !== null)
  if (withRelevance.length === 0) return null

  return withRelevance.reduce((sum, q) => sum + q.avgRelevance, 0) / withRelevance.length
}

/**
 * Calculate noise ratio (queries with low relevance results)
 */
function calculateNoiseRatio(queries) {
  const withRelevance = queries.filter(q => q.avgRelevance !== null)
  if (withRelevance.length === 0) return null

  const noisy = withRelevance.filter(q => q.avgRelevance < 0.3).length
  return noisy / withRelevance.length
}

/**
 * Calculate session continuity stats
 */
function calculateSessionContinuity(sessions) {
  const resumed = sessions.filter(s => s.resumed)
  const matched = resumed.filter(s => s.topicMatched)

  return {
    totalSessions: sessions.length,
    resumedSessions: resumed.length,
    successfulResumptions: matched.length,
    rate: resumed.length > 0 ? matched.length / resumed.length : null
  }
}

/**
 * Calculate identity stability
 */
function calculateIdentityStability(sessions) {
  if (sessions.length === 0) return null
  const recognized = sessions.filter(s => s.identityRecognized).length
  return recognized / sessions.length
}

/**
 * Calculate latency statistics
 */
function calculateLatencyStats(retrievals) {
  if (retrievals.length === 0) {
    return { p50: null, p95: null, p99: null, avg: null }
  }

  const latencies = retrievals.map(r => r.latencyMs).sort((a, b) => a - b)
  const len = latencies.length

  return {
    p50: latencies[Math.floor(len * 0.5)],
    p95: latencies[Math.floor(len * 0.95)],
    p99: latencies[Math.floor(len * 0.99)],
    avg: latencies.reduce((a, b) => a + b, 0) / len,
    min: latencies[0],
    max: latencies[len - 1]
  }
}

/**
 * Calculate memory growth rate
 */
function calculateGrowthRate(memoryStats, since, until) {
  const days = (until - since) / (24 * 60 * 60 * 1000)
  if (days === 0) return null

  // This is approximate - ideally we'd track creation timestamps
  return {
    totalItems: memoryStats.total,
    periodDays: days,
    estimatedPerDay: null // Would need timestamp tracking
  }
}

/**
 * Calculate confirmation rate
 */
function calculateConfirmationRate(confirmations) {
  // This would need total memory writes to calculate properly
  return {
    total: confirmations.length,
    approved: confirmations.filter(c => c.action === 'approved').length,
    rejected: confirmations.filter(c => c.action === 'rejected').length,
    edited: confirmations.filter(c => c.action === 'edited').length
  }
}

/**
 * Calculate confirmation statistics
 */
function calculateConfirmationStats(confirmations) {
  if (confirmations.length === 0) {
    return { avgWaitTime: null, approvalRate: null }
  }

  const waitTimes = confirmations.map(c => c.waitTimeMs).filter(t => t > 0)
  const avgWaitTime = waitTimes.length > 0
    ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length
    : null

  const approved = confirmations.filter(c => c.action === 'approved').length
  const approvalRate = approved / confirmations.length

  return { avgWaitTime, approvalRate }
}

// ============================================================================
// DASHBOARD DATA
// ============================================================================

/**
 * Get metrics formatted for dashboard display
 */
export function getDashboardMetrics(options = {}) {
  const metrics = calculateMetrics(options)

  return {
    summary: {
      health: calculateHealthScore(metrics),
      totalMemories: metrics.totalMemories,
      queriesProcessed: metrics.counts.queries,
      contradictionsFound: metrics.counts.contradictions
    },

    cards: [
      {
        id: 'recall',
        title: 'Recall Accuracy',
        value: metrics.recallAccuracy !== null
          ? `${(metrics.recallAccuracy * 100).toFixed(1)}%`
          : 'N/A',
        target: '90%',
        status: getMetricStatus(metrics.recallAccuracy, 0.9, false)
      },
      {
        id: 'latency',
        title: 'Retrieval Latency (p95)',
        value: metrics.retrievalLatency.p95 !== null
          ? `${metrics.retrievalLatency.p95}ms`
          : 'N/A',
        target: '<100ms',
        status: getMetricStatus(metrics.retrievalLatency.p95, 100, true)
      },
      {
        id: 'relevance',
        title: 'Context Relevance',
        value: metrics.contextRelevance !== null
          ? `${(metrics.contextRelevance * 100).toFixed(1)}%`
          : 'N/A',
        target: '80%',
        status: getMetricStatus(metrics.contextRelevance, 0.8, false)
      },
      {
        id: 'identity',
        title: 'Identity Stability',
        value: metrics.identityStability !== null
          ? `${(metrics.identityStability * 100).toFixed(1)}%`
          : 'N/A',
        target: '100%',
        status: getMetricStatus(metrics.identityStability, 1.0, false)
      }
    ],

    charts: {
      memoryDistribution: Object.entries(metrics.memoryByType).map(([type, count]) => ({
        name: type,
        value: count
      })),

      latencyTrend: getLatencyTrend(),

      confirmationBreakdown: metrics.confirmationRate
    },

    raw: metrics
  }
}

/**
 * Calculate overall health score (0-100)
 */
function calculateHealthScore(metrics) {
  const scores = []

  // Recall accuracy (weight: 30)
  if (metrics.recallAccuracy !== null) {
    scores.push({ score: metrics.recallAccuracy * 100, weight: 30 })
  }

  // Latency (weight: 20)
  if (metrics.retrievalLatency.p95 !== null) {
    const latencyScore = Math.max(0, 100 - metrics.retrievalLatency.p95)
    scores.push({ score: latencyScore, weight: 20 })
  }

  // Context relevance (weight: 25)
  if (metrics.contextRelevance !== null) {
    scores.push({ score: metrics.contextRelevance * 100, weight: 25 })
  }

  // Identity stability (weight: 25)
  if (metrics.identityStability !== null) {
    scores.push({ score: metrics.identityStability * 100, weight: 25 })
  }

  if (scores.length === 0) return null

  const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0)
  const weightedSum = scores.reduce((sum, s) => sum + s.score * s.weight, 0)

  return Math.round(weightedSum / totalWeight)
}

/**
 * Get status for a metric (good/warning/critical)
 */
function getMetricStatus(value, target, lowerIsBetter = false) {
  if (value === null) return 'unknown'

  const ratio = lowerIsBetter ? target / value : value / target

  if (ratio >= 1) return 'good'
  if (ratio >= 0.8) return 'warning'
  return 'critical'
}

/**
 * Get latency trend data
 */
function getLatencyTrend() {
  // Group retrievals by hour
  const hourlyData = {}

  for (const retrieval of metricsStore.retrievals) {
    const hour = retrieval.timestamp.substring(0, 13) // YYYY-MM-DDTHH
    if (!hourlyData[hour]) {
      hourlyData[hour] = []
    }
    hourlyData[hour].push(retrieval.latencyMs)
  }

  return Object.entries(hourlyData)
    .map(([hour, latencies]) => ({
      hour,
      avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      count: latencies.length
    }))
    .sort((a, b) => a.hour.localeCompare(b.hour))
    .slice(-24) // Last 24 hours
}

// ============================================================================
// MEMORY HEALTH CHECKS
// ============================================================================

/**
 * Run health checks on memory system
 */
export function runHealthChecks() {
  const mm = getMemoryManager()
  const checks = []

  // Check 1: Profile exists
  const profile = mm.getProfile()
  checks.push({
    name: 'User Profile',
    status: profile?.name ? 'pass' : 'fail',
    message: profile?.name ? `Profile loaded for ${profile.name}` : 'No user profile configured'
  })

  // Check 2: Memory types populated
  const types = ['fact', 'preference', 'constraint']
  for (const type of types) {
    const items = mm.getLearnedItemsByType(type)
    checks.push({
      name: `${type} Memories`,
      status: items.length > 0 ? 'pass' : 'warn',
      message: `${items.length} ${type}s stored`
    })
  }

  // Check 3: Recent activity
  const recentQueries = metricsStore.queries.filter(
    q => new Date(q.timestamp) > new Date(Date.now() - 60 * 60 * 1000)
  )
  checks.push({
    name: 'Recent Activity',
    status: recentQueries.length > 0 ? 'pass' : 'info',
    message: `${recentQueries.length} queries in last hour`
  })

  // Check 4: Contradiction rate
  const contradictionRate = metricsStore.contradictions.length / Math.max(1, getMemoryStats(mm).total)
  checks.push({
    name: 'Contradiction Rate',
    status: contradictionRate < 0.1 ? 'pass' : 'warn',
    message: `${(contradictionRate * 100).toFixed(1)}% of memories have conflicts`
  })

  // Summary
  const passed = checks.filter(c => c.status === 'pass').length
  const failed = checks.filter(c => c.status === 'fail').length
  const warnings = checks.filter(c => c.status === 'warn').length

  return {
    overall: failed > 0 ? 'unhealthy' : warnings > 0 ? 'degraded' : 'healthy',
    passed,
    failed,
    warnings,
    checks
  }
}

// ============================================================================
// EXPORT METRICS
// ============================================================================

/**
 * Export metrics for external analysis
 */
export function exportMetrics(format = 'json') {
  const data = {
    exportedAt: new Date().toISOString(),
    metrics: calculateMetrics({ since: 0 }), // All time
    healthChecks: runHealthChecks(),
    rawData: {
      queries: metricsStore.queries,
      retrievals: metricsStore.retrievals,
      confirmations: metricsStore.confirmations,
      contradictions: metricsStore.contradictions,
      sessions: metricsStore.sessions
    }
  }

  if (format === 'json') {
    return JSON.stringify(data, null, 2)
  }

  // CSV format for queries
  if (format === 'csv') {
    const headers = ['timestamp', 'query', 'resultCount', 'latencyMs', 'avgRelevance']
    const rows = metricsStore.queries.map(q =>
      [q.timestamp, `"${q.query}"`, q.resultCount, q.latencyMs, q.avgRelevance].join(',')
    )
    return [headers.join(','), ...rows].join('\n')
  }

  return data
}

/**
 * Clear metrics history
 */
export function clearMetrics() {
  metricsStore.queries = []
  metricsStore.retrievals = []
  metricsStore.confirmations = []
  metricsStore.contradictions = []
  metricsStore.sessions = []
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  METRIC_DEFINITIONS,

  // Recording
  recordQuery,
  recordRetrieval,
  recordConfirmation,
  recordContradiction,
  recordSession,

  // Calculation
  calculateMetrics,
  getDashboardMetrics,
  runHealthChecks,

  // Export
  exportMetrics,
  clearMetrics
}
