/**
 * AEE Analytics Service
 *
 * Analytics and pattern detection on AEE envelope data.
 * Enables insights, anomaly detection, and behavioral analysis.
 *
 * @fileoverview Turn AEE signals into intelligence
 */

import {
  queryEnvelopes,
  getConversation,
  getConversations,
  getStats
} from '../lib/aee'
import { CHAT_INTENTS, QuoxAgent_INTENTS } from '../lib/aee/intents.js'

// ============================================================================
// Conversation Statistics
// ============================================================================

/**
 * Get conversation statistics for a time range
 *
 * @param {Object} options - Query options
 * @param {string} options.startTime - Start of range (ISO)
 * @param {string} options.endTime - End of range (ISO)
 * @returns {Object} Conversation statistics
 */
export async function getConversationStats({ startTime, endTime } = {}) {
  const now = new Date()
  const defaultStart = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

  const envelopes = await queryEnvelopes({
    after: startTime || defaultStart,
    before: endTime || now.toISOString()
  })

  if (!envelopes || envelopes.length === 0) {
    return {
      total_conversations: 0,
      total_messages: 0,
      avg_messages_per_conversation: 0,
      avg_duration_ms: 0,
      conversations_by_day: {},
      busiest_hour: null,
      success_rate: 0
    }
  }

  // Group by conversation
  const conversations = new Map()
  for (const env of envelopes) {
    if (!conversations.has(env.corr)) {
      conversations.set(env.corr, [])
    }
    conversations.get(env.corr).push(env)
  }

  // Calculate per-conversation stats
  let totalDuration = 0
  let successCount = 0
  const conversationsByDay = {}
  const messagesByHour = Array(24).fill(0)

  for (const [, envs] of conversations) {
    // Duration
    const times = envs.map(e => new Date(e.ts).getTime())
    const duration = Math.max(...times) - Math.min(...times)
    totalDuration += duration

    // Success (no errors in conversation)
    const hasErrors = envs.some(e => e.type === 'error')
    if (!hasErrors) successCount++

    // Day grouping
    const day = envs[0].ts.split('T')[0]
    conversationsByDay[day] = (conversationsByDay[day] || 0) + 1

    // Hour distribution
    for (const env of envs) {
      const hour = new Date(env.ts).getHours()
      messagesByHour[hour]++
    }
  }

  // Find busiest hour
  const busiestHour = messagesByHour.indexOf(Math.max(...messagesByHour))

  return {
    total_conversations: conversations.size,
    total_messages: envelopes.length,
    avg_messages_per_conversation: Math.round(envelopes.length / conversations.size),
    avg_duration_ms: Math.round(totalDuration / conversations.size),
    conversations_by_day: conversationsByDay,
    messages_by_hour: messagesByHour,
    busiest_hour: busiestHour,
    success_rate: Math.round((successCount / conversations.size) * 100)
  }
}

// ============================================================================
// Intent Analytics
// ============================================================================

/**
 * Get intent usage statistics
 *
 * @param {Object} options - Query options
 * @returns {Object} Intent statistics
 */
export async function getIntentStats({ startTime, endTime } = {}) {
  const now = new Date()
  const defaultStart = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

  const envelopes = await queryEnvelopes({
    after: startTime || defaultStart,
    before: endTime || now.toISOString()
  })

  const intentCounts = {}
  const intentSuccessRate = {}

  for (const env of envelopes) {
    const intent = env.intent
    intentCounts[intent] = (intentCounts[intent] || 0) + 1

    // Track success for tasks
    if (env.type === 'task') {
      if (!intentSuccessRate[intent]) {
        intentSuccessRate[intent] = { total: 0, success: 0 }
      }
      intentSuccessRate[intent].total++
    }

    if (env.type === 'result') {
      const taskIntent = env.intent.replace('.response', '.query')
        .replace('.result', '.submit')
      if (intentSuccessRate[taskIntent]) {
        intentSuccessRate[taskIntent].success++
      }
    }
  }

  // Calculate success rates
  const intentMetrics = {}
  for (const [intent, data] of Object.entries(intentSuccessRate)) {
    intentMetrics[intent] = {
      count: intentCounts[intent] || 0,
      success_rate: data.total > 0
        ? Math.round((data.success / data.total) * 100)
        : null
    }
  }

  // Sort by count
  const sortedIntents = Object.entries(intentCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([intent, count]) => ({
      intent,
      count,
      success_rate: intentMetrics[intent]?.success_rate
    }))

  return {
    total_intents_used: Object.keys(intentCounts).length,
    intent_breakdown: intentCounts,
    top_intents: sortedIntents.slice(0, 10),
    intent_metrics: intentMetrics
  }
}

// ============================================================================
// Host Activity Analytics
// ============================================================================

/**
 * Get activity statistics for a specific host
 *
 * @param {string} hostId - Host identifier
 * @param {Object} options - Query options
 * @returns {Object} Host activity stats
 */
export async function getHostActivityStats(hostId, { startTime, endTime } = {}) {
  const now = new Date()
  const defaultStart = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()

  const envelopes = await queryEnvelopes({
    after: startTime || defaultStart,
    before: endTime || now.toISOString()
  })

  // Filter to QuoxAgent envelopes for this host
  const hostEnvelopes = envelopes.filter(e =>
    e.from === `quoxagent.${hostId}` ||
    e.to === `quoxagent.${hostId}` ||
    (e.payload && JSON.stringify(e.payload).includes(hostId))
  )

  if (hostEnvelopes.length === 0) {
    return {
      host_id: hostId,
      total_interactions: 0,
      jobs_executed: 0,
      success_rate: 0,
      common_commands: [],
      error_patterns: [],
      last_seen: null
    }
  }

  // Analyze jobs
  const jobs = hostEnvelopes.filter(e => e.intent === QuoxAgent_INTENTS.JOB_SUBMIT)
  const jobResults = hostEnvelopes.filter(e => e.intent === QuoxAgent_INTENTS.JOB_RESULT)

  // Count successes
  let successCount = 0
  for (const result of jobResults) {
    if (result.payload?.exit_code === 0) successCount++
  }

  // Extract commands
  const commandCounts = {}
  for (const job of jobs) {
    const cmd = job.payload?.command?.split(' ')[0] || 'unknown'
    commandCounts[cmd] = (commandCounts[cmd] || 0) + 1
  }

  const commonCommands = Object.entries(commandCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cmd, count]) => ({ command: cmd, count }))

  // Extract error patterns
  const errors = hostEnvelopes.filter(e => e.type === 'error')
  const errorPatterns = {}
  for (const err of errors) {
    const msg = err.payload?.message || 'Unknown error'
    const pattern = msg.substring(0, 50)
    errorPatterns[pattern] = (errorPatterns[pattern] || 0) + 1
  }

  const topErrors = Object.entries(errorPatterns)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([pattern, count]) => ({ pattern, count }))

  // Last seen
  const lastSeen = hostEnvelopes
    .filter(e => e.from === `quoxagent.${hostId}`)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0]?.ts

  return {
    host_id: hostId,
    total_interactions: hostEnvelopes.length,
    jobs_executed: jobs.length,
    jobs_completed: jobResults.length,
    success_rate: jobResults.length > 0
      ? Math.round((successCount / jobResults.length) * 100)
      : 0,
    common_commands: commonCommands,
    error_patterns: topErrors,
    last_seen: lastSeen,
    heartbeats: hostEnvelopes.filter(e =>
      e.intent === QuoxAgent_INTENTS.HEARTBEAT
    ).length
  }
}

/**
 * Get fleet-wide analytics
 *
 * @param {Object} options - Query options
 * @returns {Object} Fleet statistics
 */
export async function getFleetStats({ startTime, endTime } = {}) {
  const now = new Date()
  const defaultStart = new Date(now - 24 * 60 * 60 * 1000).toISOString()

  const envelopes = await queryEnvelopes({
    after: startTime || defaultStart,
    before: endTime || now.toISOString()
  })

  // Extract unique hosts from QuoxAgent envelopes
  const hosts = new Set()
  const hostStats = {}

  for (const env of envelopes) {
    // Extract host from quoxagent.* addresses
    if (env.from?.startsWith('quoxagent.')) {
      const host = env.from.replace('quoxagent.', '')
      hosts.add(host)
      if (!hostStats[host]) {
        hostStats[host] = { messages: 0, heartbeats: 0, jobs: 0, errors: 0 }
      }
      hostStats[host].messages++
      if (env.intent === QuoxAgent_INTENTS.HEARTBEAT) hostStats[host].heartbeats++
    }

    if (env.to?.startsWith('quoxagent.')) {
      const host = env.to.replace('quoxagent.', '')
      hosts.add(host)
      if (!hostStats[host]) {
        hostStats[host] = { messages: 0, heartbeats: 0, jobs: 0, errors: 0 }
      }
      if (env.intent === QuoxAgent_INTENTS.JOB_SUBMIT) hostStats[host].jobs++
    }

    if (env.type === 'error' && env.from?.startsWith('quoxagent.')) {
      const host = env.from.replace('quoxagent.', '')
      if (hostStats[host]) hostStats[host].errors++
    }
  }

  // Sort hosts by activity
  const sortedHosts = Object.entries(hostStats)
    .sort((a, b) => b[1].messages - a[1].messages)
    .map(([host, stats]) => ({ host, ...stats }))

  return {
    total_hosts: hosts.size,
    hosts: Array.from(hosts),
    host_activity: sortedHosts,
    most_active: sortedHosts[0]?.host || null,
    total_heartbeats: envelopes.filter(e =>
      e.intent === QuoxAgent_INTENTS.HEARTBEAT
    ).length,
    total_jobs: envelopes.filter(e =>
      e.intent === QuoxAgent_INTENTS.JOB_SUBMIT
    ).length
  }
}

// ============================================================================
// User Behavior Analytics
// ============================================================================

/**
 * Get user behavior statistics
 *
 * @param {string} userId - User identifier (optional, defaults to all)
 * @param {Object} options - Query options
 * @returns {Object} User behavior stats
 */
export async function getUserBehaviorStats(userId = null, { startTime, endTime } = {}) {
  const now = new Date()
  const defaultStart = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

  let envelopes = await queryEnvelopes({
    after: startTime || defaultStart,
    before: endTime || now.toISOString()
  })

  if (userId) {
    envelopes = envelopes.filter(e => e.from === userId)
  } else {
    // Only human messages
    envelopes = envelopes.filter(e => e.from?.startsWith('human.'))
  }

  if (envelopes.length === 0) {
    return {
      total_queries: 0,
      active_hours: [],
      common_topics: [],
      avg_query_length: 0
    }
  }

  // Activity by hour
  const hourCounts = Array(24).fill(0)
  for (const env of envelopes) {
    const hour = new Date(env.ts).getHours()
    hourCounts[hour]++
  }

  // Find active hours (above average)
  const avgHourly = envelopes.length / 24
  const activeHours = hourCounts
    .map((count, hour) => ({ hour, count }))
    .filter(h => h.count > avgHourly)
    .sort((a, b) => b.count - a.count)

  // Extract query topics (simple word frequency)
  const wordCounts = {}
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'on', 'in', 'at', 'to', 'for', 'of', 'and', 'or', 'but',
    'can', 'you', 'i', 'me', 'my', 'what', 'how', 'why', 'when',
    'check', 'show', 'get', 'tell', 'help', 'please', 'thanks'
  ])

  let totalQueryLength = 0
  let queryCount = 0

  for (const env of envelopes) {
    if (env.payload?.text) {
      const text = env.payload.text.toLowerCase()
      totalQueryLength += text.length
      queryCount++

      const words = text.split(/\s+/)
      for (const word of words) {
        const clean = word.replace(/[^a-z0-9]/g, '')
        if (clean.length > 2 && !stopWords.has(clean)) {
          wordCounts[clean] = (wordCounts[clean] || 0) + 1
        }
      }
    }
  }

  const commonTopics = Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }))

  return {
    total_queries: queryCount,
    active_hours: activeHours.slice(0, 5),
    peak_hour: activeHours[0]?.hour,
    common_topics: commonTopics,
    avg_query_length: queryCount > 0
      ? Math.round(totalQueryLength / queryCount)
      : 0,
    activity_by_hour: hourCounts
  }
}

// ============================================================================
// Pattern Detection
// ============================================================================

/**
 * Detect patterns and anomalies in AEE data
 *
 * @param {Object} options - Analysis options
 * @returns {Object} Detected patterns
 */
export async function detectPatterns({ startTime, endTime, sensitivity = 'medium' } = {}) {
  const now = new Date()
  const defaultStart = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

  const envelopes = await queryEnvelopes({
    after: startTime || defaultStart,
    before: endTime || now.toISOString()
  })

  const patterns = {
    repeated_failures: [],
    time_correlations: [],
    host_patterns: [],
    anomalies: []
  }

  if (envelopes.length < 10) {
    return patterns
  }

  // Sensitivity thresholds
  const thresholds = {
    low: { failure_count: 5, correlation: 0.7 },
    medium: { failure_count: 3, correlation: 0.5 },
    high: { failure_count: 2, correlation: 0.3 }
  }[sensitivity]

  // 1. Repeated failures
  const errorsByIntent = {}
  for (const env of envelopes.filter(e => e.type === 'error')) {
    const key = `${env.intent}:${env.to}`
    if (!errorsByIntent[key]) {
      errorsByIntent[key] = { count: 0, examples: [] }
    }
    errorsByIntent[key].count++
    if (errorsByIntent[key].examples.length < 3) {
      errorsByIntent[key].examples.push({
        id: env.id,
        ts: env.ts,
        message: env.payload?.message?.substring(0, 100)
      })
    }
  }

  for (const [key, data] of Object.entries(errorsByIntent)) {
    if (data.count >= thresholds.failure_count) {
      const [intent, target] = key.split(':')
      patterns.repeated_failures.push({
        intent,
        target,
        count: data.count,
        examples: data.examples,
        severity: data.count >= 5 ? 'high' : 'medium'
      })
    }
  }

  // 2. Time correlations (errors clustered at certain times)
  const errorsByHour = Array(24).fill(0)
  for (const env of envelopes.filter(e => e.type === 'error')) {
    const hour = new Date(env.ts).getHours()
    errorsByHour[hour]++
  }

  const avgErrorsPerHour = errorsByHour.reduce((a, b) => a + b, 0) / 24
  for (let hour = 0; hour < 24; hour++) {
    if (errorsByHour[hour] > avgErrorsPerHour * 2) {
      patterns.time_correlations.push({
        hour,
        error_count: errorsByHour[hour],
        avg: Math.round(avgErrorsPerHour),
        suggestion: `Errors spike at ${hour}:00 - investigate scheduled tasks`
      })
    }
  }

  // 3. Host patterns (hosts that frequently appear in errors)
  const hostErrorCounts = {}
  for (const env of envelopes.filter(e => e.type === 'error')) {
    const host = env.from?.replace('quoxagent.', '') || env.to?.replace('quoxagent.', '')
    if (host && !host.startsWith('human.') && !host.startsWith('agent.')) {
      hostErrorCounts[host] = (hostErrorCounts[host] || 0) + 1
    }
  }

  for (const [host, count] of Object.entries(hostErrorCounts)) {
    if (count >= thresholds.failure_count) {
      patterns.host_patterns.push({
        host,
        error_count: count,
        severity: count >= 5 ? 'high' : 'medium',
        suggestion: `Host ${host} has elevated error rate`
      })
    }
  }

  // 4. Anomalies (unusual patterns)
  // Spike detection: Compare recent hour to baseline
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString()
  const recentEnvelopes = envelopes.filter(e => e.ts > oneHourAgo)
  const olderEnvelopes = envelopes.filter(e => e.ts <= oneHourAgo)

  const recentRate = recentEnvelopes.length
  const baselineRate = olderEnvelopes.length / Math.max(1,
    (new Date(oneHourAgo) - new Date(startTime || defaultStart)) / (60 * 60 * 1000)
  )

  if (recentRate > baselineRate * 3) {
    patterns.anomalies.push({
      type: 'activity_spike',
      description: 'Unusual activity spike in last hour',
      recent_count: recentRate,
      baseline_hourly: Math.round(baselineRate),
      severity: 'medium'
    })
  }

  // Check for sudden silence (no heartbeats)
  const recentHeartbeats = recentEnvelopes.filter(e =>
    e.intent === QuoxAgent_INTENTS.HEARTBEAT
  )
  if (recentHeartbeats.length === 0 && envelopes.some(e =>
    e.intent === QuoxAgent_INTENTS.HEARTBEAT
  )) {
    patterns.anomalies.push({
      type: 'heartbeat_silence',
      description: 'No QuoxAgent heartbeats in last hour',
      severity: 'high'
    })
  }

  return patterns
}

// ============================================================================
// Summary Dashboard
// ============================================================================

/**
 * Get a comprehensive analytics dashboard
 *
 * @param {Object} options - Dashboard options
 * @returns {Object} Dashboard data
 */
export async function getDashboardStats({ timeRange = '24h' } = {}) {
  const now = new Date()
  const ranges = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000
  }

  const startTime = new Date(now - (ranges[timeRange] || ranges['24h'])).toISOString()
  const endTime = now.toISOString()

  // Gather all stats in parallel
  const [
    conversationStats,
    intentStats,
    fleetStats,
    userStats,
    patterns,
    dbStats
  ] = await Promise.all([
    getConversationStats({ startTime, endTime }),
    getIntentStats({ startTime, endTime }),
    getFleetStats({ startTime, endTime }),
    getUserBehaviorStats(null, { startTime, endTime }),
    detectPatterns({ startTime, endTime }),
    getStats()
  ])

  return {
    time_range: timeRange,
    generated_at: endTime,
    overview: {
      total_envelopes: dbStats.total,
      total_conversations: conversationStats.total_conversations,
      success_rate: conversationStats.success_rate,
      active_hosts: fleetStats.total_hosts
    },
    conversations: conversationStats,
    intents: intentStats,
    fleet: fleetStats,
    user_behavior: userStats,
    patterns,
    health: {
      has_anomalies: patterns.anomalies.length > 0,
      anomaly_count: patterns.anomalies.length,
      repeated_failure_count: patterns.repeated_failures.length
    }
  }
}

export default {
  getConversationStats,
  getIntentStats,
  getHostActivityStats,
  getFleetStats,
  getUserBehaviorStats,
  detectPatterns,
  getDashboardStats
}
