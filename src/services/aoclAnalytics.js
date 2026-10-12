/**
 * AOCL Analytics Service
 *
 * Aggregates and analyzes layer performance metrics from AEE storage.
 * Provides insights for optimization and debugging.
 *
 * Part of AOCL (Agent Orchestration Control Layers)
 */

import { queryEnvelopes, AOCL_LAYERS, AOCL_LAYER_ORDER } from '../lib/aee/index.js'

/**
 * Time range presets
 */
export const TIME_RANGES = {
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
  MONTH: 30 * 24 * 60 * 60 * 1000
}

/**
 * Get layer statistics for a time range
 *
 * @param {Object} options
 * @param {number} options.timeRange - Time range in ms (default: 24 hours)
 * @param {string} options.layer - Specific layer to analyze (optional)
 * @returns {Promise<Object>} Layer statistics
 */
export async function getLayerStats(options = {}) {
  const { timeRange = TIME_RANGES.DAY, layer } = options

  const since = new Date(Date.now() - timeRange).toISOString()

  try {
    // Query all AOCL layer events
    const events = await queryEnvelopes({
      intentPrefix: 'aocl.layer',
      since,
      limit: 5000
    })

    // Group by layer
    const layerData = {}

    for (const event of events) {
      const layerId = event.payload?.layer
      const status = event.payload?.status

      if (!layerId) continue
      if (layer && layerId !== layer) continue

      if (!layerData[layerId]) {
        layerData[layerId] = {
          layerId,
          label: AOCL_LAYERS[layerId]?.label || layerId,
          color: AOCL_LAYERS[layerId]?.color || '#6b7280',
          starts: 0,
          completes: 0,
          bypasses: 0,
          rejects: 0,
          durations: [],
          errors: []
        }
      }

      const data = layerData[layerId]

      switch (status) {
        case 'start':
          data.starts++
          break
        case 'complete':
          data.completes++
          if (event.payload?.duration_ms) {
            data.durations.push(event.payload.duration_ms)
          }
          break
        case 'bypass':
          data.bypasses++
          break
        case 'reject':
          data.rejects++
          if (event.payload?.reason) {
            data.errors.push({
              reason: event.payload.reason,
              ts: event.ts
            })
          }
          break
      }
    }

    // Calculate statistics for each layer
    const stats = {}

    for (const [layerId, data] of Object.entries(layerData)) {
      const durations = data.durations
      const total = data.completes + data.bypasses + data.rejects

      stats[layerId] = {
        layerId,
        label: data.label,
        color: data.color,
        total,
        completes: data.completes,
        bypasses: data.bypasses,
        rejects: data.rejects,
        bypassRate: total > 0 ? (data.bypasses / total * 100).toFixed(1) : 0,
        errorRate: total > 0 ? (data.rejects / total * 100).toFixed(1) : 0,
        timing: durations.length > 0 ? {
          avg: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
          min: Math.min(...durations),
          max: Math.max(...durations),
          p50: percentile(durations, 50),
          p95: percentile(durations, 95),
          p99: percentile(durations, 99)
        } : null,
        recentErrors: data.errors.slice(-5)
      }
    }

    // Order by AOCL_LAYER_ORDER
    const orderedStats = AOCL_LAYER_ORDER
      .filter(id => stats[id])
      .map(id => stats[id])

    return {
      timeRange,
      since,
      layerCount: Object.keys(stats).length,
      totalEvents: events.length,
      layers: orderedStats,
      summary: {
        totalRequests: stats['L0']?.completes || 0,
        avgTotalDuration: orderedStats.reduce((sum, l) => sum + (l.timing?.avg || 0), 0),
        mostBypassedLayer: orderedStats.sort((a, b) => b.bypassRate - a.bypassRate)[0]?.layerId,
        slowestLayer: orderedStats.filter(l => l.timing).sort((a, b) => (b.timing?.avg || 0) - (a.timing?.avg || 0))[0]?.layerId
      }
    }
  } catch (error) {
    console.error('[AOCLAnalytics] getLayerStats error:', error)
    return {
      timeRange,
      error: error.message,
      layers: [],
      summary: {}
    }
  }
}

/**
 * Get layers that exceed a duration threshold
 *
 * @param {number} threshold - Duration threshold in ms (default: 1000)
 * @param {Object} options
 * @param {number} options.timeRange - Time range in ms
 * @returns {Promise<Object[]>} Slow layer occurrences
 */
export async function getSlowLayers(threshold = 1000, options = {}) {
  const { timeRange = TIME_RANGES.DAY } = options
  const since = new Date(Date.now() - timeRange).toISOString()

  try {
    const events = await queryEnvelopes({
      intentPrefix: 'aocl.layer.complete',
      since,
      limit: 2000
    })

    const slowEvents = events.filter(e =>
      e.payload?.duration_ms && e.payload.duration_ms > threshold
    )

    // Group by layer
    const byLayer = {}
    for (const event of slowEvents) {
      const layerId = event.payload?.layer
      if (!layerId) continue

      if (!byLayer[layerId]) {
        byLayer[layerId] = {
          layerId,
          label: AOCL_LAYERS[layerId]?.label || layerId,
          count: 0,
          durations: [],
          samples: []
        }
      }

      byLayer[layerId].count++
      byLayer[layerId].durations.push(event.payload.duration_ms)
      if (byLayer[layerId].samples.length < 5) {
        byLayer[layerId].samples.push({
          duration_ms: event.payload.duration_ms,
          ts: event.ts,
          corr: event.corr
        })
      }
    }

    // Calculate stats and sort by count
    const results = Object.values(byLayer)
      .map(layer => ({
        ...layer,
        avgDuration: Math.round(layer.durations.reduce((a, b) => a + b, 0) / layer.durations.length),
        maxDuration: Math.max(...layer.durations)
      }))
      .sort((a, b) => b.count - a.count)

    return {
      threshold,
      timeRange,
      totalSlow: slowEvents.length,
      layers: results
    }
  } catch (error) {
    console.error('[AOCLAnalytics] getSlowLayers error:', error)
    return { threshold, timeRange, error: error.message, layers: [] }
  }
}

/**
 * Get bypass rate for a specific layer over time
 *
 * @param {string} layerId - Layer ID (e.g., 'L2', 'L3')
 * @param {Object} options
 * @param {number} options.timeRange - Time range in ms
 * @param {number} options.buckets - Number of time buckets (default: 24)
 * @returns {Promise<Object>} Bypass rate trend data
 */
export async function getBypassRate(layerId, options = {}) {
  const { timeRange = TIME_RANGES.DAY, buckets = 24 } = options
  const since = new Date(Date.now() - timeRange).toISOString()
  const bucketSize = timeRange / buckets

  try {
    const events = await queryEnvelopes({
      intentPrefix: 'aocl.layer',
      since,
      limit: 5000
    })

    // Filter to target layer
    const layerEvents = events.filter(e => e.payload?.layer === layerId)

    // Initialize buckets
    const bucketData = Array(buckets).fill(null).map((_, i) => ({
      start: Date.now() - timeRange + (i * bucketSize),
      end: Date.now() - timeRange + ((i + 1) * bucketSize),
      completes: 0,
      bypasses: 0,
      rejects: 0
    }))

    // Fill buckets
    for (const event of layerEvents) {
      const ts = new Date(event.ts).getTime()
      const bucketIndex = Math.floor((ts - (Date.now() - timeRange)) / bucketSize)

      if (bucketIndex >= 0 && bucketIndex < buckets) {
        const status = event.payload?.status
        if (status === 'complete') bucketData[bucketIndex].completes++
        else if (status === 'bypass') bucketData[bucketIndex].bypasses++
        else if (status === 'reject') bucketData[bucketIndex].rejects++
      }
    }

    // Calculate rates
    const trend = bucketData.map(bucket => {
      const total = bucket.completes + bucket.bypasses + bucket.rejects
      return {
        time: new Date(bucket.start).toISOString(),
        total,
        bypassRate: total > 0 ? (bucket.bypasses / total * 100) : 0,
        errorRate: total > 0 ? (bucket.rejects / total * 100) : 0
      }
    })

    // Overall stats
    const totalCompletes = layerEvents.filter(e => e.payload?.status === 'complete').length
    const totalBypasses = layerEvents.filter(e => e.payload?.status === 'bypass').length
    const totalRejects = layerEvents.filter(e => e.payload?.status === 'reject').length
    const total = totalCompletes + totalBypasses + totalRejects

    return {
      layerId,
      label: AOCL_LAYERS[layerId]?.label || layerId,
      timeRange,
      overall: {
        total,
        completes: totalCompletes,
        bypasses: totalBypasses,
        rejects: totalRejects,
        bypassRate: total > 0 ? (totalBypasses / total * 100).toFixed(1) : 0,
        errorRate: total > 0 ? (totalRejects / total * 100).toFixed(1) : 0
      },
      trend
    }
  } catch (error) {
    console.error('[AOCLAnalytics] getBypassRate error:', error)
    return { layerId, timeRange, error: error.message, trend: [] }
  }
}

/**
 * Get error patterns across layers
 *
 * @param {Object} options
 * @param {number} options.timeRange - Time range in ms
 * @returns {Promise<Object>} Error pattern analysis
 */
export async function getErrorPatterns(options = {}) {
  const { timeRange = TIME_RANGES.DAY } = options
  const since = new Date(Date.now() - timeRange).toISOString()

  try {
    // Get layer rejects
    const layerErrors = await queryEnvelopes({
      intentPrefix: 'aocl.layer.reject',
      since,
      limit: 1000
    })

    // Get run errors
    const runErrors = await queryEnvelopes({
      intentPrefix: 'aocl.run.error',
      since,
      limit: 500
    })

    // Group by reason
    const reasonCounts = {}
    const layerErrorCounts = {}

    for (const event of layerErrors) {
      const reason = event.payload?.reason || 'Unknown'
      const layer = event.payload?.layer || 'Unknown'

      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1

      if (!layerErrorCounts[layer]) {
        layerErrorCounts[layer] = { layer, count: 0, reasons: {} }
      }
      layerErrorCounts[layer].count++
      layerErrorCounts[layer].reasons[reason] = (layerErrorCounts[layer].reasons[reason] || 0) + 1
    }

    // Sort by frequency
    const topReasons = Object.entries(reasonCounts)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    const layerBreakdown = Object.values(layerErrorCounts)
      .sort((a, b) => b.count - a.count)

    return {
      timeRange,
      totalLayerErrors: layerErrors.length,
      totalRunErrors: runErrors.length,
      topReasons,
      layerBreakdown,
      recentErrors: [...layerErrors, ...runErrors]
        .sort((a, b) => new Date(b.ts) - new Date(a.ts))
        .slice(0, 10)
        .map(e => ({
          ts: e.ts,
          layer: e.payload?.layer,
          reason: e.payload?.reason || e.payload?.error,
          corr: e.corr
        }))
    }
  } catch (error) {
    console.error('[AOCLAnalytics] getErrorPatterns error:', error)
    return { timeRange, error: error.message, topReasons: [], layerBreakdown: [] }
  }
}

/**
 * Get run completion statistics
 *
 * @param {Object} options
 * @param {number} options.timeRange - Time range in ms
 * @returns {Promise<Object>} Run completion stats
 */
export async function getRunStats(options = {}) {
  const { timeRange = TIME_RANGES.DAY } = options
  const since = new Date(Date.now() - timeRange).toISOString()

  try {
    const completeEvents = await queryEnvelopes({
      intentPrefix: 'aocl.run.complete',
      since,
      limit: 2000
    })

    const errorEvents = await queryEnvelopes({
      intentPrefix: 'aocl.run.error',
      since,
      limit: 500
    })

    const durations = completeEvents
      .filter(e => e.payload?.totalDuration_ms)
      .map(e => e.payload.totalDuration_ms)

    const successCount = completeEvents.filter(e => e.payload?.success !== false).length
    const failCount = errorEvents.length + completeEvents.filter(e => e.payload?.success === false).length

    // Handler breakdown
    const handlers = {}
    for (const event of completeEvents) {
      const handler = event.payload?.handledBy || event.payload?.provider || 'llm'
      handlers[handler] = (handlers[handler] || 0) + 1
    }

    const totalRuns = successCount + failCount
    return {
      timeRange,
      total: completeEvents.length + errorEvents.length,
      success: successCount,
      failed: failCount,
      successRate: totalRuns > 0 ? (successCount / totalRuns * 100).toFixed(1) : null,
      timing: durations.length > 0 ? {
        avg: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
        min: Math.min(...durations),
        max: Math.max(...durations),
        p50: percentile(durations, 50),
        p95: percentile(durations, 95)
      } : null,
      handlers: Object.entries(handlers)
        .map(([handler, count]) => ({ handler, count }))
        .sort((a, b) => b.count - a.count)
    }
  } catch (error) {
    console.error('[AOCLAnalytics] getRunStats error:', error)
    return { timeRange, error: error.message }
  }
}

/**
 * Get optimization recommendations based on analytics
 *
 * @param {Object} options
 * @param {number} options.timeRange - Time range in ms
 * @returns {Promise<Object[]>} Recommendations
 */
export async function getRecommendations(options = {}) {
  const recommendations = []

  try {
    const [layerStats, slowLayers, runStats] = await Promise.all([
      getLayerStats(options),
      getSlowLayers(1000, options),
      getRunStats(options)
    ])

    // Check for slow layers
    if (slowLayers.layers?.length > 0) {
      const slowest = slowLayers.layers[0]
      if (slowest.avgDuration > 2000) {
        recommendations.push({
          type: 'performance',
          severity: 'warning',
          layer: slowest.layerId,
          title: `${slowest.label} layer is slow`,
          description: `Average duration ${slowest.avgDuration}ms exceeds threshold. Consider caching or optimization.`,
          metric: `${slowest.count} slow executions`
        })
      }
    }

    // Check bypass rates
    for (const layer of layerStats.layers || []) {
      if (parseFloat(layer.bypassRate) > 50) {
        recommendations.push({
          type: 'efficiency',
          severity: 'info',
          layer: layer.layerId,
          title: `High bypass rate for ${layer.label}`,
          description: `${layer.bypassRate}% of requests bypass this layer. Consider if it should be disabled.`,
          metric: `${layer.bypasses}/${layer.total} bypassed`
        })
      }
    }

    // Check error rates
    for (const layer of layerStats.layers || []) {
      if (parseFloat(layer.errorRate) > 5) {
        recommendations.push({
          type: 'reliability',
          severity: 'error',
          layer: layer.layerId,
          title: `High error rate for ${layer.label}`,
          description: `${layer.errorRate}% of requests fail at this layer. Investigate recent errors.`,
          metric: `${layer.rejects} failures`
        })
      }
    }

    // Check overall success rate
    if (runStats.successRate && parseFloat(runStats.successRate) < 95) {
      recommendations.push({
        type: 'reliability',
        severity: 'warning',
        title: 'Overall success rate below target',
        description: `Success rate is ${runStats.successRate}%. Target is 95%+.`,
        metric: `${runStats.failed} failed runs`
      })
    }

    // Smart Router optimization
    const smartRouterHandler = runStats.handlers?.find(h => h.handler === 'smart-router')
    if (smartRouterHandler && smartRouterHandler.count / runStats.total < 0.1) {
      recommendations.push({
        type: 'efficiency',
        severity: 'info',
        title: 'Low Smart Router utilization',
        description: 'Consider adding more patterns to Smart Router to reduce LLM calls.',
        metric: `${(smartRouterHandler.count / runStats.total * 100).toFixed(1)}% routed`
      })
    }

    return recommendations.sort((a, b) => {
      const severityOrder = { error: 0, warning: 1, info: 2 }
      return severityOrder[a.severity] - severityOrder[b.severity]
    })

  } catch (error) {
    console.error('[AOCLAnalytics] getRecommendations error:', error)
    return [{
      type: 'error',
      severity: 'error',
      title: 'Analytics unavailable',
      description: error.message
    }]
  }
}

/**
 * Calculate percentile from array of numbers
 */
function percentile(arr, p) {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, index)]
}

export default {
  getLayerStats,
  getSlowLayers,
  getBypassRate,
  getErrorPatterns,
  getRunStats,
  getRecommendations,
  TIME_RANGES
}
