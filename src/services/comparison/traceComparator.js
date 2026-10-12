/**
 * Trace Comparator Service
 *
 * Provides trace comparison functionality for side-by-side analysis.
 * Part of AOCL Compliance Suite (Enterprise plugin).
 *
 * TRV-1: Server-side persistence via collector /traces/comparisons endpoints.
 * No localStorage. All comparisons are durable across devices and browser clears.
 *
 * Features:
 * - Compare two or more traces
 * - Analyze timing, decisions, content, and costs
 * - Save comparisons for later review
 * - Generate diff reports
 */

import { prefixedUlid } from '../../lib/aee/ulid'
import { getConversation, queryEnvelopes } from '../../lib/aee/store'
import { AOCL_LAYERS } from '../../lib/aee/envelope'

// ============================================================================
// Server Persistence Helpers
// ============================================================================

const COLLECTOR_BASE = '/collector'

async function fetchJson(path, options = {}) {
  const res = await fetch(`${COLLECTOR_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `Server error: ${res.status}`)
  }
  return res.json()
}

// ============================================================================
// Comparison Management (server-backed)
// ============================================================================

/**
 * Get all saved comparisons from server
 * @returns {Promise<Array>} Array of saved comparisons
 */
export async function getSavedComparisons() {
  try {
    const { comparisons } = await fetchJson('/traces/comparisons?limit=200')
    return comparisons || []
  } catch (err) {
    console.error('[Comparison] Failed to load comparisons:', err)
    return []
  }
}

/**
 * Creates a new comparison between two or more traces
 *
 * @param {string[]} corrIds - Correlation IDs of traces to compare
 * @param {Object} [options] - Comparison options
 * @param {string[]} [options.dimensions] - Dimensions to compare (timing, decisions, content, costs)
 * @param {string} [options.name] - Optional name for the comparison
 * @returns {Promise<Object>} Comparison results
 */
export async function createComparison(corrIds, options = {}) {
  if (!corrIds || corrIds.length < 2) {
    throw new Error('At least two traces are required for comparison')
  }

  const dimensions = options.dimensions || ['timing', 'decisions', 'content', 'costs']

  // Load all traces
  const traces = await Promise.all(
    corrIds.map(async (corr) => {
      const envelopes = await getConversation(corr)
      return parseTraceData(corr, envelopes)
    })
  )

  // Create comparison object
  const comparison = {
    id: prefixedUlid('CMP'),
    name: options.name || `Comparison ${new Date().toLocaleDateString()}`,
    createdAt: new Date().toISOString(),
    traces: traces.map(t => ({
      corr: t.corr,
      query: t.query,
      timestamp: t.timestamp
    })),
    results: {}
  }

  // Compare each dimension
  if (dimensions.includes('timing')) {
    comparison.results.timing = compareTimings(traces)
  }
  if (dimensions.includes('decisions')) {
    comparison.results.decisions = compareDecisions(traces)
  }
  if (dimensions.includes('content')) {
    comparison.results.content = compareContent(traces)
  }
  if (dimensions.includes('costs')) {
    comparison.results.costs = compareCosts(traces)
  }

  // Calculate overall similarity score
  comparison.similarity = calculateSimilarity(comparison.results)

  // Persist to server
  try {
    await fetchJson('/traces/comparisons', {
      method: 'POST',
      body: JSON.stringify({
        id: comparison.id,
        name: comparison.name,
        corr_ids: corrIds,
        options,
        result: comparison,
        similarity_score: comparison.similarity / 100
      })
    })
  } catch (err) {
    console.error('[Comparison] Failed to persist comparison:', err)
  }

  return comparison
}

/**
 * Parse trace data from envelopes
 */
function parseTraceData(corr, envelopes) {
  const queryEnvelope = envelopes.find(e => e.intent === 'quox.chat.query')
  const responseEnvelope = envelopes.find(e => e.intent === 'quox.chat.response')
  const layerEnvelopes = envelopes.filter(e => e.intent?.startsWith('aocl.layer.'))
  const runCompleteEnvelope = envelopes.find(e => e.intent === 'aocl.run.complete')

  // Parse layer events
  const layers = {}
  for (const env of layerEnvelopes) {
    const layerId = env.payload?.layer
    if (!layerId) continue

    if (!layers[layerId]) {
      layers[layerId] = { events: [] }
    }
    layers[layerId].events.push({
      status: env.payload?.status,
      timestamp: env.ts,
      duration_ms: env.payload?.duration_ms,
      payload: env.payload
    })
  }

  // Calculate layer durations
  for (const layerId of Object.keys(layers)) {
    const events = layers[layerId].events
    const startEvent = events.find(e => e.status === 'start')
    const completeEvent = events.find(e => e.status === 'complete')
    layers[layerId].duration_ms = completeEvent?.duration_ms || 0
    layers[layerId].status = completeEvent?.status || startEvent?.status || 'unknown'
  }

  return {
    corr,
    query: queryEnvelope?.payload?.text || '',
    response: responseEnvelope?.payload?.text || '',
    timestamp: queryEnvelope?.ts || envelopes[0]?.ts,
    layers,
    totalDuration_ms: runCompleteEnvelope?.payload?.duration_ms || 0,
    success: runCompleteEnvelope?.payload?.success !== false,
    model: responseEnvelope?.payload?.model,
    usage: responseEnvelope?.payload?.usage,
    routingDecision: layerEnvelopes.find(e => e.payload?.layer === 'L2')?.payload,
    policyDecision: layerEnvelopes.find(e => e.payload?.layer === 'L3')?.payload,
    envelopes
  }
}

/**
 * Compare timing across traces
 */
function compareTimings(traces) {
  const result = {
    totalDurations: traces.map(t => ({
      corr: t.corr,
      duration_ms: t.totalDuration_ms
    })),
    layers: {},
    summary: {}
  }

  // Get all unique layers
  const allLayers = new Set()
  for (const trace of traces) {
    Object.keys(trace.layers).forEach(l => allLayers.add(l))
  }

  // Compare each layer
  for (const layerId of allLayers) {
    result.layers[layerId] = {
      label: AOCL_LAYERS[layerId]?.label || layerId,
      color: AOCL_LAYERS[layerId]?.color || '#888',
      traces: traces.map(t => ({
        corr: t.corr,
        duration_ms: t.layers[layerId]?.duration_ms || 0,
        status: t.layers[layerId]?.status || 'missing'
      }))
    }
  }

  // Calculate summary stats
  const durations = traces.map(t => t.totalDuration_ms)
  result.summary = {
    min: Math.min(...durations),
    max: Math.max(...durations),
    avg: durations.reduce((a, b) => a + b, 0) / durations.length,
    spread: Math.max(...durations) - Math.min(...durations),
    spreadPercent: ((Math.max(...durations) - Math.min(...durations)) / Math.min(...durations) * 100).toFixed(1)
  }

  return result
}

/**
 * Compare decisions across traces
 */
function compareDecisions(traces) {
  const result = {
    routing: [],
    policy: [],
    context: [],
    differences: []
  }

  // Compare routing decisions (L2)
  for (const trace of traces) {
    result.routing.push({
      corr: trace.corr,
      handled: trace.routingDecision?.handled || false,
      pattern: trace.routingDecision?.pattern || null,
      confidence: trace.routingDecision?.confidence || 0,
      reason: trace.routingDecision?.reason || 'unknown'
    })
  }

  // Check if routing decisions differ
  const routingHandled = result.routing.map(r => r.handled)
  if (new Set(routingHandled).size > 1) {
    result.differences.push({
      type: 'routing',
      description: 'Routing decisions differ across traces',
      values: result.routing.map(r => ({ corr: r.corr, handled: r.handled, pattern: r.pattern }))
    })
  }

  // Compare policy decisions (L3)
  for (const trace of traces) {
    result.policy.push({
      corr: trace.corr,
      allowed: trace.policyDecision?.allowed !== false,
      reason: trace.policyDecision?.reason || 'passed',
      checks: trace.policyDecision?.checks || []
    })
  }

  // Check if policy decisions differ
  const policyAllowed = result.policy.map(p => p.allowed)
  if (new Set(policyAllowed).size > 1) {
    result.differences.push({
      type: 'policy',
      description: 'Policy decisions differ across traces',
      values: result.policy.map(p => ({ corr: p.corr, allowed: p.allowed, reason: p.reason }))
    })
  }

  return result
}

/**
 * Compare content across traces
 */
function compareContent(traces) {
  const result = {
    queries: traces.map(t => ({
      corr: t.corr,
      text: t.query,
      length: t.query.length
    })),
    responses: traces.map(t => ({
      corr: t.corr,
      text: t.response,
      length: t.response.length
    })),
    diff: null
  }

  // Generate diff between first two traces
  if (traces.length >= 2) {
    result.diff = generateTextDiff(traces[0].response, traces[1].response)
  }

  // Check query similarity
  const queries = traces.map(t => t.query)
  result.queriesIdentical = queries.every(q => q === queries[0])

  // Check response similarity
  const responses = traces.map(t => t.response)
  result.responsesIdentical = responses.every(r => r === responses[0])

  // Calculate text similarity (simple Jaccard-like)
  if (traces.length >= 2) {
    result.similarity = calculateTextSimilarity(traces[0].response, traces[1].response)
  }

  return result
}

/**
 * Compare costs across traces
 */
function compareCosts(traces) {
  const result = {
    traces: traces.map(t => ({
      corr: t.corr,
      model: t.model || 'unknown',
      inputTokens: t.usage?.input_tokens || 0,
      outputTokens: t.usage?.output_tokens || 0,
      totalTokens: (t.usage?.input_tokens || 0) + (t.usage?.output_tokens || 0)
    })),
    summary: {}
  }

  // Calculate summary
  const totalTokens = result.traces.map(t => t.totalTokens)
  result.summary = {
    minTokens: Math.min(...totalTokens),
    maxTokens: Math.max(...totalTokens),
    avgTokens: Math.round(totalTokens.reduce((a, b) => a + b, 0) / totalTokens.length),
    tokenSpread: Math.max(...totalTokens) - Math.min(...totalTokens)
  }

  return result
}

/**
 * Generate text diff between two strings
 */
function generateTextDiff(text1 = '', text2 = '') {
  const lines1 = text1.split('\n')
  const lines2 = text2.split('\n')

  const diff = {
    added: 0,
    removed: 0,
    unchanged: 0,
    changes: []
  }

  const maxLines = Math.max(lines1.length, lines2.length)

  for (let i = 0; i < maxLines; i++) {
    const line1 = lines1[i]
    const line2 = lines2[i]

    if (line1 === line2) {
      diff.unchanged++
    } else if (line1 === undefined) {
      diff.added++
      diff.changes.push({ type: 'added', line: i + 1, content: line2 })
    } else if (line2 === undefined) {
      diff.removed++
      diff.changes.push({ type: 'removed', line: i + 1, content: line1 })
    } else {
      diff.removed++
      diff.added++
      diff.changes.push({ type: 'changed', line: i + 1, from: line1, to: line2 })
    }
  }

  diff.changes = diff.changes.slice(0, 50) // Limit for UI
  diff.totalChanges = diff.added + diff.removed

  return diff
}

/**
 * Calculate text similarity (simple word overlap)
 */
function calculateTextSimilarity(text1 = '', text2 = '') {
  const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2))

  const intersection = new Set([...words1].filter(w => words2.has(w)))
  const union = new Set([...words1, ...words2])

  if (union.size === 0) return 100

  return Math.round((intersection.size / union.size) * 100)
}

/**
 * Calculate overall similarity score
 */
function calculateSimilarity(results) {
  let score = 100

  // Timing similarity
  if (results.timing) {
    const spreadPercent = parseFloat(results.timing.summary.spreadPercent) || 0
    score -= Math.min(spreadPercent / 2, 20) // Max 20 point penalty
  }

  // Decision similarity
  if (results.decisions) {
    score -= results.decisions.differences.length * 15 // 15 points per difference
  }

  // Content similarity
  if (results.content) {
    if (!results.content.responsesIdentical) {
      score -= (100 - (results.content.similarity || 0)) / 2
    }
  }

  return Math.max(0, Math.round(score))
}

/**
 * Get a comparison by ID (from server)
 */
export async function getComparison(comparisonId) {
  try {
    const { comparison } = await fetchJson(`/traces/comparisons/${comparisonId}`)
    // Full comparison object stored in result field
    if (comparison?.result && typeof comparison.result === 'object') {
      return comparison.result
    }
    return comparison || null
  } catch {
    return null
  }
}

/**
 * Save/update a comparison name (on server)
 */
export async function saveComparison(comparisonId, name) {
  try {
    await fetchJson(`/traces/comparisons/${comparisonId}`, {
      method: 'PUT',
      body: JSON.stringify({ name })
    })
    return true
  } catch {
    return false
  }
}

/**
 * Delete a comparison (from server)
 */
export async function deleteComparison(comparisonId) {
  try {
    await fetchJson(`/traces/comparisons/${comparisonId}`, { method: 'DELETE' })
    return true
  } catch {
    return false
  }
}

/**
 * Clear all comparisons (from server)
 */
export async function clearAllComparisons() {
  try {
    await fetchJson('/traces/comparisons', { method: 'DELETE' })
  } catch (err) {
    console.error('[Comparison] Failed to clear comparisons:', err)
  }
}
