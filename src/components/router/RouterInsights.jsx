/**
 * RouterInsights - Smart Router Analytics Dashboard
 *
 * Visual dashboard showing Smart Router performance metrics,
 * pattern effectiveness, decision stream, and recommendations.
 *
 * Part of the Smart Router visibility enhancement initiative.
 */

import { useState, useEffect, useMemo } from 'react'
import { getRouterStats } from '../../services/quoxRouter'
import { getRouterConfig } from '../../services/routerConfig'
import './router.css'

/**
 * Time range options for filtering
 */
const TIME_OPTIONS = [
  { label: 'Last Hour', value: 3600000 },
  { label: 'Last 24 Hours', value: 86400000 },
  { label: 'All Time', value: 0 }
]

/**
 * RouterInsights Component
 *
 * @param {Object} props
 * @param {boolean} props.compact - Compact mode for embedding
 * @param {Function} props.onPatternClick - Handler for pattern click
 */
export function RouterInsights({ compact = false, onPatternClick }) {
  const [timeRange, setTimeRange] = useState(3600000)
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState(null)
  const [config, setConfig] = useState(null)
  const [selectedPattern, setSelectedPattern] = useState(null)

  // Fetch router stats
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true)
      try {
        const [statsData, configData] = await Promise.all([
          getRouterStats(),
          Promise.resolve(getRouterConfig())
        ])

        setStats(statsData)
        setConfig(configData)
      } catch (err) {
        console.error('[RouterInsights] Fetch error:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
    // Refresh every 30 seconds
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [timeRange])

  // Calculate pattern stats with effectiveness
  const patternData = useMemo(() => {
    if (!stats?.patternStats) return []

    return Object.entries(stats.patternStats)
      .map(([pattern, data]) => {
        const effectivenessRate = data.count > 0
          ? Math.round(((data.count - data.escalations - data.reformulations) / data.count) * 100)
          : 100

        return {
          pattern,
          ...data,
          effectivenessRate
        }
      })
      .sort((a, b) => b.count - a.count)
  }, [stats])

  // Generate recommendations
  const recommendations = useMemo(() => {
    if (!stats) return []

    const recs = []

    // High reformulation rate
    if (stats.reformulations?.rate > 15) {
      recs.push({
        severity: 'warning',
        title: 'High Reformulation Rate',
        description: 'Users are rephrasing queries after routed responses, indicating possible mismatches.',
        metric: `${stats.reformulations.rate}% reformulation rate`
      })
    }

    // High escalation rate
    if (stats.escalations?.rate > 10) {
      recs.push({
        severity: 'warning',
        title: 'High Escalation Rate',
        description: 'Users frequently click "Ask Claude" after routed responses.',
        metric: `${stats.escalations.rate}% escalation rate`
      })
    }

    // Low bypass rate
    if (stats.bypassRate < 20 && stats.total > 50) {
      recs.push({
        severity: 'info',
        title: 'Low Routing Rate',
        description: 'Most queries are passing through to Claude. Consider adding more patterns.',
        metric: `${stats.bypassRate}% routed`
      })
    }

    // Pattern-specific issues
    for (const [pattern, data] of Object.entries(stats.patternStats || {})) {
      if (data.count >= 5) {
        const escalationRate = (data.escalations / data.count) * 100
        if (escalationRate > 20) {
          recs.push({
            severity: 'error',
            title: `Pattern "${pattern}" Underperforming`,
            description: 'High escalation rate indicates users are dissatisfied with this pattern\'s responses.',
            metric: `${escalationRate.toFixed(0)}% escalation rate (${data.escalations}/${data.count})`
          })
        }
      }
    }

    return recs.slice(0, compact ? 2 : 5)
  }, [stats, compact])

  const handlePatternClick = (pattern) => {
    setSelectedPattern(selectedPattern === pattern ? null : pattern)
    onPatternClick?.(pattern)
  }

  if (loading) {
    return (
      <div className="router-insights router-insights--loading">
        <div className="router-insights-spinner" />
        <span>Loading router analytics...</span>
      </div>
    )
  }

  return (
    <div className={`router-insights ${compact ? 'router-insights--compact' : ''}`}>
      {/* Header */}
      <div className="router-insights-header">
        <div className="router-insights-title">
          <span className="router-insights-icon">&#9889;</span>
          Smart Router Insights
        </div>
        <select
          className="router-insights-range"
          value={timeRange}
          onChange={(e) => setTimeRange(Number(e.target.value))}
        >
          {TIME_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Empty State */}
      {(!stats || stats.total === 0) && (
        <div className="router-insights-empty">
          <div className="router-insights-empty-icon">&#128171;</div>
          <h3>No Router Data Yet</h3>
          <p>
            Router analytics will appear here once you start chatting.
            The Smart Router intercepts common queries and handles them
            directly without calling Claude.
          </p>
          <p className="router-insights-empty-hint">
            Try asking "What is Quox?" or "fleet status" to see routing in action.
          </p>
        </div>
      )}

      {/* Summary Stats */}
      {stats && stats.total > 0 && (
        <div className="router-insights-summary">
          <div className="router-stat" title="Total queries processed by the router">
            <span className="router-stat-value">{stats.total}</span>
            <span className="router-stat-label">Total Queries</span>
          </div>
          <div className="router-stat router-stat--success" title="Percentage of queries handled without calling Claude">
            <span className="router-stat-value">{stats.bypassRate}%</span>
            <span className="router-stat-label">Routed</span>
          </div>
          <div className="router-stat" title="Queries passed through to Claude">
            <span className="router-stat-value">{stats.misses}</span>
            <span className="router-stat-label">To Claude</span>
          </div>
          <div className="router-stat router-stat--warning" title="Times users asked Claude after a routed response">
            <span className="router-stat-value">{stats.escalations?.total || 0}</span>
            <span className="router-stat-label">Escalations</span>
          </div>
        </div>
      )}

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className="router-insights-section">
          <h3 className="router-insights-section-title">Recommendations</h3>
          <div className="router-insights-recommendations">
            {recommendations.map((rec, i) => (
              <div
                key={i}
                className={`router-recommendation router-recommendation--${rec.severity}`}
              >
                <span className="router-recommendation-icon">
                  {rec.severity === 'error' ? '\u{1F6A8}' : rec.severity === 'warning' ? '\u26A0\uFE0F' : '\u2139\uFE0F'}
                </span>
                <div className="router-recommendation-content">
                  <div className="router-recommendation-title">{rec.title}</div>
                  <div className="router-recommendation-desc">{rec.description}</div>
                  {rec.metric && (
                    <div className="router-recommendation-metric">{rec.metric}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pattern Performance Grid */}
      {patternData.length > 0 && (
        <div className="router-insights-section">
          <h3 className="router-insights-section-title">Pattern Performance</h3>
          <div className="router-insights-grid">
            {patternData.slice(0, compact ? 6 : 12).map(pattern => (
              <div
                key={pattern.pattern}
                className={`router-pattern-card ${selectedPattern === pattern.pattern ? 'router-pattern-card--selected' : ''}`}
                onClick={() => handlePatternClick(pattern.pattern)}
              >
                <div className="router-pattern-card-header">
                  <span className="router-pattern-badge">
                    {pattern.pattern.replace(/_/g, ' ')}
                  </span>
                </div>

                <div className="router-pattern-card-stats">
                  <div className="router-pattern-stat">
                    <span className="router-pattern-stat-value">{pattern.count}</span>
                    <span className="router-pattern-stat-label">matches</span>
                  </div>
                  <div className="router-pattern-stat">
                    <span className="router-pattern-stat-value">{pattern.effectivenessRate}%</span>
                    <span className="router-pattern-stat-label">effective</span>
                  </div>
                </div>

                {/* Effectiveness bar */}
                <div className="router-pattern-bar">
                  <div
                    className="router-pattern-bar-fill"
                    style={{ width: `${pattern.effectivenessRate}%` }}
                    title={`${pattern.effectivenessRate}% effectiveness`}
                  />
                </div>

                {/* Expanded details */}
                {selectedPattern === pattern.pattern && (
                  <div className="router-pattern-details">
                    <div className="router-pattern-detail-row">
                      <span>Total Matches:</span>
                      <span>{pattern.count}</span>
                    </div>
                    <div className="router-pattern-detail-row">
                      <span>Escalations:</span>
                      <span className="router-pattern-detail-warning">
                        {pattern.escalations} ({pattern.count > 0 ? Math.round((pattern.escalations / pattern.count) * 100) : 0}%)
                      </span>
                    </div>
                    <div className="router-pattern-detail-row">
                      <span>Reformulations:</span>
                      <span className="router-pattern-detail-warning">
                        {pattern.reformulations} ({pattern.count > 0 ? Math.round((pattern.reformulations / pattern.count) * 100) : 0}%)
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Decision Stream */}
      {stats?.recentPatterns?.length > 0 && !compact && (
        <div className="router-insights-section">
          <h3 className="router-insights-section-title">Recent Patterns Used</h3>
          <div className="router-decision-stream">
            {stats.recentPatterns.slice(0, 8).map((pattern, i) => (
              <span key={i} className="router-decision-tag">
                {pattern.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Router Config Summary */}
      {config && !compact && (
        <div className="router-insights-section">
          <h3 className="router-insights-section-title">Router Configuration</h3>
          <div className="router-config-summary">
            <div className="router-config-item">
              <span className="router-config-label">Mode:</span>
              <span className="router-config-value">{config.mode || 'STANDARD'}</span>
            </div>
            <div className="router-config-item">
              <span className="router-config-label">Min Confidence:</span>
              <span className="router-config-value">{(config.thresholds?.confidence || 0.65) * 100}%</span>
            </div>
            <div className="router-config-item">
              <span className="router-config-label">High Confidence:</span>
              <span className="router-config-value">{(config.thresholds?.highConfidence || 0.9) * 100}%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Compact Router Health Card for dashboards
 */
export function RouterHealthCard({ onClick }) {
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const stats = await getRouterStats()

        setHealth({
          total: stats?.total || 0,
          bypassRate: stats?.bypassRate || 0,
          escalationRate: stats?.escalations?.rate || 0,
          hasIssues: (stats?.escalations?.rate || 0) > 10
        })
      } catch (err) {
        console.error('[RouterHealthCard] Error:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchHealth()
    const interval = setInterval(fetchHealth, 60000)
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <div className="router-health-card router-health-card--loading">
        <span>Loading...</span>
      </div>
    )
  }

  const isHealthy = health && !health.hasIssues && health.bypassRate > 0

  return (
    <div
      className={`router-health-card ${isHealthy ? 'router-health-card--healthy' : 'router-health-card--warning'}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      <div className="router-health-card-header">
        <span className="router-health-card-icon">
          {isHealthy ? '\u2713' : '\u26A0'}
        </span>
        <span className="router-health-card-title">Smart Router</span>
      </div>
      <div className="router-health-card-stats">
        <div className="router-health-stat">
          <span className="router-health-stat-value">{health?.total || 0}</span>
          <span className="router-health-stat-label">queries</span>
        </div>
        <div className="router-health-stat">
          <span className="router-health-stat-value">{health?.bypassRate || 0}%</span>
          <span className="router-health-stat-label">routed</span>
        </div>
        <div className="router-health-stat">
          <span className="router-health-stat-value">{health?.escalationRate || 0}%</span>
          <span className="router-health-stat-label">escalated</span>
        </div>
      </div>
    </div>
  )
}

export default RouterInsights
