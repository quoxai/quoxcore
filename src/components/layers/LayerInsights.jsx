/**
 * LayerInsights - AOCL Analytics Dashboard
 *
 * Visual dashboard showing layer performance metrics,
 * bypass rates, error patterns, and optimization recommendations.
 *
 * Part of AOCL (Agent Orchestration Control Layers)
 */

import { useState, useEffect, useMemo } from 'react'
import {
  getLayerStats,
  getSlowLayers,
  getErrorPatterns,
  getRunStats,
  getRecommendations,
  TIME_RANGES
} from '../../services/aoclAnalytics'
import { AOCL_LAYERS, AOCL_LAYER_ORDER } from '../../lib/aee'
import './layers.css'

/**
 * Time range selector options
 */
const TIME_OPTIONS = [
  { label: 'Last Hour', value: TIME_RANGES.HOUR },
  { label: 'Last 24 Hours', value: TIME_RANGES.DAY },
  { label: 'Last Week', value: TIME_RANGES.WEEK },
  { label: 'Last Month', value: TIME_RANGES.MONTH }
]

/**
 * LayerInsights Component
 *
 * @param {Object} props
 * @param {boolean} props.compact - Compact mode for embedding
 * @param {Function} props.onLayerClick - Handler for layer click
 */
export function LayerInsights({ compact = false, onLayerClick }) {
  const [timeRange, setTimeRange] = useState(TIME_RANGES.DAY)
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState(null)
  const [runStats, setRunStats] = useState(null)
  const [slowLayers, setSlowLayers] = useState(null)
  const [errors, setErrors] = useState(null)
  const [recommendations, setRecommendations] = useState([])
  const [selectedLayer, setSelectedLayer] = useState(null)

  // Fetch all analytics data
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true)
      try {
        const [statsData, runData, slowData, errorData, recsData] = await Promise.all([
          getLayerStats({ timeRange }),
          getRunStats({ timeRange }),
          getSlowLayers(1000, { timeRange }),
          getErrorPatterns({ timeRange }),
          getRecommendations({ timeRange })
        ])

        setStats(statsData)
        setRunStats(runData)
        setSlowLayers(slowData)
        setErrors(errorData)
        setRecommendations(recsData)
      } catch (err) {
        console.error('[LayerInsights] Fetch error:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [timeRange])

  const formatDuration = (ms) => {
    if (ms === null || ms === undefined) return '-'
    if (ms < 1) return '<1ms'
    if (ms < 1000) return `${Math.round(ms)}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  const handleLayerClick = (layerId) => {
    setSelectedLayer(selectedLayer === layerId ? null : layerId)
    onLayerClick?.(layerId)
  }

  if (loading) {
    return (
      <div className="layer-insights layer-insights--loading">
        <div className="layer-insights-spinner" />
        <span>Loading analytics...</span>
      </div>
    )
  }

  return (
    <div className={`layer-insights ${compact ? 'layer-insights--compact' : ''}`}>
      {/* Header */}
      <div className="layer-insights-header">
        <div className="layer-insights-title">
          <span className="layer-insights-icon">📊</span>
          Layer Insights
        </div>
        <select
          className="layer-insights-range"
          value={timeRange}
          onChange={(e) => setTimeRange(Number(e.target.value))}
        >
          {TIME_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Empty State */}
      {(!runStats || runStats.total === 0) && (
        <div className="layer-insights-empty">
          <div className="layer-insights-empty-icon">📭</div>
          <h3>No Layer Data Yet</h3>
          <p>
            Layer analytics will appear here once you start chatting.
            Each message you send is processed through multiple layers
            (routing, context, execution, etc.) and tracked here.
          </p>
          <p className="layer-insights-empty-hint">
            Try sending a message in the Command view to generate data.
          </p>
        </div>
      )}

      {/* Summary Stats - only show when we have data */}
      {runStats && runStats.total > 0 && (
        <div className="layer-insights-summary">
          <div className="insight-stat" title="Number of complete message processing runs">
            <span className="insight-stat-value">{runStats.total}</span>
            <span className="insight-stat-label">Total Runs</span>
          </div>
          <div className="insight-stat insight-stat--success" title="Percentage of runs that completed without errors">
            <span className="insight-stat-value">
              {runStats.successRate !== null ? `${runStats.successRate}%` : '-'}
            </span>
            <span className="insight-stat-label">Success Rate</span>
          </div>
          <div className="insight-stat" title="Average time from message received to response sent">
            <span className="insight-stat-value">{formatDuration(runStats?.timing?.avg)}</span>
            <span className="insight-stat-label">Avg Duration</span>
          </div>
          <div className="insight-stat" title="95th percentile - 95% of runs complete faster than this">
            <span className="insight-stat-value">{formatDuration(runStats?.timing?.p95)}</span>
            <span className="insight-stat-label">P95 Duration</span>
          </div>
        </div>
      )}

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className="layer-insights-section">
          <h3 className="layer-insights-section-title">Recommendations</h3>
          <div className="layer-insights-recommendations">
            {recommendations.slice(0, compact ? 2 : 5).map((rec, i) => (
              <div
                key={i}
                className={`insight-recommendation insight-recommendation--${rec.severity}`}
              >
                <span className="insight-recommendation-icon">
                  {rec.severity === 'error' ? '🚨' : rec.severity === 'warning' ? '⚠️' : 'ℹ️'}
                </span>
                <div className="insight-recommendation-content">
                  <div className="insight-recommendation-title">{rec.title}</div>
                  <div className="insight-recommendation-desc">{rec.description}</div>
                  {rec.metric && (
                    <div className="insight-recommendation-metric">{rec.metric}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Layer Performance Grid */}
      <div className="layer-insights-section">
        <h3 className="layer-insights-section-title">Layer Performance</h3>
        <div className="layer-insights-grid">
          {stats?.layers?.map(layer => (
            <div
              key={layer.layerId}
              className={`layer-insight-card ${selectedLayer === layer.layerId ? 'layer-insight-card--selected' : ''}`}
              onClick={() => handleLayerClick(layer.layerId)}
              style={{ '--layer-color': layer.color }}
            >
              <div className="layer-insight-card-header">
                <span
                  className="layer-insight-badge"
                  style={{ background: layer.color }}
                >
                  {layer.layerId}
                </span>
                <span className="layer-insight-label">{layer.label}</span>
              </div>

              <div className="layer-insight-card-stats">
                <div className="layer-insight-stat">
                  <span className="layer-insight-stat-value">
                    {layer.total}
                  </span>
                  <span className="layer-insight-stat-label">calls</span>
                </div>
                <div className="layer-insight-stat">
                  <span className="layer-insight-stat-value">
                    {formatDuration(layer.timing?.avg)}
                  </span>
                  <span className="layer-insight-stat-label">avg</span>
                </div>
              </div>

              {/* Mini bar chart for completion/bypass/error */}
              <div className="layer-insight-bar">
                <div
                  className="layer-insight-bar-complete"
                  style={{ width: `${layer.total > 0 ? (layer.completes / layer.total * 100) : 0}%` }}
                  title={`${layer.completes} completed`}
                />
                <div
                  className="layer-insight-bar-bypass"
                  style={{ width: `${layer.total > 0 ? (layer.bypasses / layer.total * 100) : 0}%` }}
                  title={`${layer.bypasses} bypassed`}
                />
                <div
                  className="layer-insight-bar-error"
                  style={{ width: `${layer.total > 0 ? (layer.rejects / layer.total * 100) : 0}%` }}
                  title={`${layer.rejects} failed`}
                />
              </div>

              {/* Expanded details */}
              {selectedLayer === layer.layerId && (
                <div className="layer-insight-details">
                  <div className="layer-insight-detail-row">
                    <span>Completed:</span>
                    <span>{layer.completes}</span>
                  </div>
                  <div className="layer-insight-detail-row">
                    <span>Bypassed:</span>
                    <span>{layer.bypasses} ({layer.bypassRate}%)</span>
                  </div>
                  <div className="layer-insight-detail-row">
                    <span>Failed:</span>
                    <span>{layer.rejects} ({layer.errorRate}%)</span>
                  </div>
                  {layer.timing && (
                    <>
                      <div className="layer-insight-detail-row">
                        <span>Min/Max:</span>
                        <span>{formatDuration(layer.timing.min)} / {formatDuration(layer.timing.max)}</span>
                      </div>
                      <div className="layer-insight-detail-row">
                        <span>P95:</span>
                        <span>{formatDuration(layer.timing.p95)}</span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Handler Breakdown */}
      {runStats?.handlers?.length > 0 && !compact && (
        <div className="layer-insights-section">
          <h3 className="layer-insights-section-title">Request Handlers</h3>
          <div className="layer-insights-handlers">
            {runStats.handlers.map(({ handler, count }) => (
              <div key={handler} className="insight-handler">
                <span className="insight-handler-name">
                  {handler === 'smart-router' ? '⚡ Smart Router' :
                   handler === 'claude' ? '🤖 Claude' : handler}
                </span>
                <div className="insight-handler-bar">
                  <div
                    className="insight-handler-fill"
                    style={{ width: `${(count / runStats.total * 100)}%` }}
                  />
                </div>
                <span className="insight-handler-count">
                  {count} ({(count / runStats.total * 100).toFixed(1)}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Errors */}
      {errors?.recentErrors?.length > 0 && !compact && (
        <div className="layer-insights-section">
          <h3 className="layer-insights-section-title">Recent Errors</h3>
          <div className="layer-insights-errors">
            {errors.recentErrors.slice(0, 5).map((err, i) => (
              <div key={i} className="insight-error">
                <span className="insight-error-layer">{err.layer || 'run'}</span>
                <span className="insight-error-reason">{err.reason}</span>
                <span className="insight-error-time">
                  {new Date(err.ts).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Slow Layers */}
      {slowLayers?.layers?.length > 0 && !compact && (
        <div className="layer-insights-section">
          <h3 className="layer-insights-section-title">
            Slow Executions (&gt;1s)
          </h3>
          <div className="layer-insights-slow">
            {slowLayers.layers.slice(0, 3).map(layer => (
              <div key={layer.layerId} className="insight-slow">
                <span
                  className="insight-slow-badge"
                  style={{ background: AOCL_LAYERS[layer.layerId]?.color }}
                >
                  {layer.layerId}
                </span>
                <span className="insight-slow-label">{layer.label}</span>
                <span className="insight-slow-count">{layer.count}x</span>
                <span className="insight-slow-avg">avg {formatDuration(layer.avgDuration)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Compact Layer Health Card for dashboards
 */
export function LayerHealthCard({ onClick }) {
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const [stats, runStats] = await Promise.all([
          getLayerStats({ timeRange: TIME_RANGES.HOUR }),
          getRunStats({ timeRange: TIME_RANGES.HOUR })
        ])

        setHealth({
          totalRuns: runStats?.total || 0,
          successRate: runStats?.successRate || 100,
          avgDuration: runStats?.timing?.avg,
          activeLayers: stats?.layers?.filter(l => l.total > 0).length || 0,
          hasErrors: (runStats?.failed || 0) > 0
        })
      } catch (err) {
        console.error('[LayerHealthCard] Error:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchHealth()
    const interval = setInterval(fetchHealth, 60000) // Refresh every minute
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <div className="layer-health-card layer-health-card--loading">
        <span>Loading...</span>
      </div>
    )
  }

  const isHealthy = health && parseFloat(health.successRate) >= 95 && !health.hasErrors

  return (
    <div
      className={`layer-health-card ${isHealthy ? 'layer-health-card--healthy' : 'layer-health-card--warning'}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      <div className="layer-health-card-header">
        <span className="layer-health-card-icon">
          {isHealthy ? '✓' : '⚠'}
        </span>
        <span className="layer-health-card-title">AOCL Health</span>
      </div>
      <div className="layer-health-card-stats">
        <div className="layer-health-stat">
          <span className="layer-health-stat-value">{health?.totalRuns || 0}</span>
          <span className="layer-health-stat-label">runs/hr</span>
        </div>
        <div className="layer-health-stat">
          <span className="layer-health-stat-value">{health?.successRate || 100}%</span>
          <span className="layer-health-stat-label">success</span>
        </div>
        <div className="layer-health-stat">
          <span className="layer-health-stat-value">{health?.activeLayers || 0}</span>
          <span className="layer-health-stat-label">layers</span>
        </div>
      </div>
    </div>
  )
}

export default LayerInsights
