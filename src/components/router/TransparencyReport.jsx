/**
 * TransparencyReport - Smart Router Performance Summary
 *
 * Weekly/monthly statistics report showing routing performance,
 * user satisfaction, and improvement trends.
 *
 * Part of the Smart Router visibility enhancement initiative.
 */

import { useState, useEffect, useMemo } from 'react'
import { getRouterStats } from '../../services/quoxRouter'
import { getFeedbackStats } from './RouterFeedback'
import './router.css'

// Storage key for historical data
const HISTORY_STORAGE_KEY = 'quox-router-history'

/**
 * Get historical data from storage
 */
function getHistoricalData() {
  try {
    const data = localStorage.getItem(HISTORY_STORAGE_KEY)
    return data ? JSON.parse(data) : { daily: [], weekly: [] }
  } catch {
    return { daily: [], weekly: [] }
  }
}

/**
 * Record daily snapshot (call once per day)
 */
export function recordDailySnapshot() {
  try {
    const stats = getRouterStats()
    const feedback = getFeedbackStats()
    const history = getHistoricalData()

    const today = new Date().toISOString().split('T')[0]

    // Don't record if we already have today's data
    if (history.daily.some(d => d.date === today)) {
      return
    }

    const snapshot = {
      date: today,
      totalQueries: stats.totalQueries || 0,
      routedQueries: stats.routedQueries || 0,
      escalations: stats.escalations || 0,
      avgConfidence: stats.avgConfidence || 0,
      feedbackPositive: feedback.total?.positive || 0,
      feedbackNegative: feedback.total?.negative || 0
    }

    history.daily.push(snapshot)

    // Keep last 90 days
    if (history.daily.length > 90) {
      history.daily = history.daily.slice(-90)
    }

    // Generate weekly summary if it's Sunday
    if (new Date().getDay() === 0) {
      const weekData = history.daily.slice(-7)
      if (weekData.length > 0) {
        history.weekly.push({
          weekEnding: today,
          totalQueries: weekData.reduce((sum, d) => sum + d.totalQueries, 0),
          routedQueries: weekData.reduce((sum, d) => sum + d.routedQueries, 0),
          escalations: weekData.reduce((sum, d) => sum + d.escalations, 0),
          avgConfidence: weekData.reduce((sum, d) => sum + d.avgConfidence, 0) / weekData.length,
          feedbackPositive: weekData.reduce((sum, d) => sum + d.feedbackPositive, 0),
          feedbackNegative: weekData.reduce((sum, d) => sum + d.feedbackNegative, 0)
        })

        // Keep last 52 weeks
        if (history.weekly.length > 52) {
          history.weekly = history.weekly.slice(-52)
        }
      }
    }

    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history))
  } catch (err) {
    console.warn('[TransparencyReport] Failed to record snapshot:', err)
  }
}

/**
 * TransparencyReport Component
 */
export function TransparencyReport({ period = 'week', compact = false }) {
  const [stats, setStats] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [history, setHistory] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadData = () => {
      const statsData = getRouterStats()
      const feedbackData = getFeedbackStats()
      const historyData = getHistoricalData()

      setStats(statsData)
      setFeedback(feedbackData)
      setHistory(historyData)
      setLoading(false)
    }

    loadData()
  }, [])

  // Calculate metrics
  const metrics = useMemo(() => {
    if (!stats || !feedback) return null

    const totalQueries = stats.totalQueries || 0
    const routedQueries = stats.routedQueries || 0
    const escalations = stats.escalations || 0
    const positiveF = feedback.total?.positive || 0
    const negativeF = feedback.total?.negative || 0
    const totalFeedback = positiveF + negativeF

    return {
      totalQueries,
      routedQueries,
      routingRate: totalQueries > 0 ? (routedQueries / totalQueries * 100).toFixed(1) : 0,
      escalationRate: routedQueries > 0 ? (escalations / routedQueries * 100).toFixed(1) : 0,
      satisfactionRate: totalFeedback > 0 ? (positiveF / totalFeedback * 100).toFixed(1) : 'N/A',
      tokensEstimatedSaved: routedQueries * 300, // ~300 tokens per routed query
      timeEstimatedSaved: routedQueries * 2.5 // ~2.5 seconds per query
    }
  }, [stats, feedback])

  // Get trend data
  const trends = useMemo(() => {
    if (!history || history.daily.length < 2) return null

    const recent = history.daily.slice(-7)
    const previous = history.daily.slice(-14, -7)

    if (recent.length === 0 || previous.length === 0) return null

    const recentRouting = recent.reduce((sum, d) => sum + (d.routedQueries / Math.max(d.totalQueries, 1)), 0) / recent.length
    const previousRouting = previous.reduce((sum, d) => sum + (d.routedQueries / Math.max(d.totalQueries, 1)), 0) / previous.length

    const recentEscalation = recent.reduce((sum, d) => sum + (d.escalations / Math.max(d.routedQueries, 1)), 0) / recent.length
    const previousEscalation = previous.reduce((sum, d) => sum + (d.escalations / Math.max(d.routedQueries, 1)), 0) / previous.length

    return {
      routingTrend: ((recentRouting - previousRouting) * 100).toFixed(1),
      escalationTrend: ((recentEscalation - previousEscalation) * 100).toFixed(1)
    }
  }, [history])

  // Top patterns by volume
  const topPatterns = useMemo(() => {
    if (!stats?.patternStats) return []

    return Object.entries(stats.patternStats)
      .map(([name, data]) => ({
        name,
        count: data.count || 0,
        escalations: data.escalations || 0,
        feedbackPositive: feedback?.byPattern?.[name]?.positive || 0,
        feedbackNegative: feedback?.byPattern?.[name]?.negative || 0
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
  }, [stats, feedback])

  if (loading) {
    return (
      <div className="router-report router-report--loading">
        Loading report...
      </div>
    )
  }

  if (!metrics) {
    return (
      <div className="router-report router-report--empty">
        <p>No routing data available yet.</p>
        <p className="router-report-hint">Data will appear as you use the Smart Router.</p>
      </div>
    )
  }

  if (compact) {
    return (
      <div className="router-report router-report--compact">
        <div className="router-report-compact-grid">
          <div className="router-report-compact-stat">
            <span className="router-report-compact-value">{metrics.routingRate}%</span>
            <span className="router-report-compact-label">Routed</span>
          </div>
          <div className="router-report-compact-stat">
            <span className="router-report-compact-value">{metrics.satisfactionRate}%</span>
            <span className="router-report-compact-label">Satisfaction</span>
          </div>
          <div className="router-report-compact-stat">
            <span className="router-report-compact-value">{metrics.escalationRate}%</span>
            <span className="router-report-compact-label">Escalations</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="router-report">
      <div className="router-report-header">
        <h3 className="router-report-title">Smart Router Transparency Report</h3>
        <span className="router-report-period">
          {period === 'week' ? 'Last 7 Days' : 'Last 30 Days'}
        </span>
      </div>

      {/* Key Metrics */}
      <div className="router-report-metrics">
        <div className="router-report-metric">
          <div className="router-report-metric-value">{metrics.totalQueries.toLocaleString()}</div>
          <div className="router-report-metric-label">Total Queries</div>
        </div>
        <div className="router-report-metric router-report-metric--highlight">
          <div className="router-report-metric-value">{metrics.routingRate}%</div>
          <div className="router-report-metric-label">Routing Rate</div>
          {trends && (
            <div className={`router-report-metric-trend ${parseFloat(trends.routingTrend) >= 0 ? 'router-report-metric-trend--up' : 'router-report-metric-trend--down'}`}>
              {parseFloat(trends.routingTrend) >= 0 ? '↑' : '↓'} {Math.abs(parseFloat(trends.routingTrend))}%
            </div>
          )}
        </div>
        <div className="router-report-metric">
          <div className="router-report-metric-value">{metrics.satisfactionRate}%</div>
          <div className="router-report-metric-label">User Satisfaction</div>
        </div>
        <div className="router-report-metric">
          <div className="router-report-metric-value">{metrics.escalationRate}%</div>
          <div className="router-report-metric-label">Escalation Rate</div>
          {trends && (
            <div className={`router-report-metric-trend ${parseFloat(trends.escalationTrend) <= 0 ? 'router-report-metric-trend--up' : 'router-report-metric-trend--down'}`}>
              {parseFloat(trends.escalationTrend) <= 0 ? '↓' : '↑'} {Math.abs(parseFloat(trends.escalationTrend))}%
            </div>
          )}
        </div>
      </div>

      {/* Savings */}
      <div className="router-report-savings">
        <div className="router-report-savings-item">
          <span className="router-report-savings-icon">💰</span>
          <span className="router-report-savings-value">~{(metrics.tokensEstimatedSaved / 1000).toFixed(0)}K</span>
          <span className="router-report-savings-label">tokens saved</span>
        </div>
        <div className="router-report-savings-item">
          <span className="router-report-savings-icon">⏱️</span>
          <span className="router-report-savings-value">~{(metrics.timeEstimatedSaved / 60).toFixed(0)}</span>
          <span className="router-report-savings-label">minutes saved</span>
        </div>
      </div>

      {/* Top Patterns */}
      {topPatterns.length > 0 && (
        <div className="router-report-patterns">
          <h4 className="router-report-section-title">Top Patterns</h4>
          <div className="router-report-patterns-list">
            {topPatterns.map((pattern, i) => {
              const total = pattern.feedbackPositive + pattern.feedbackNegative
              const satisfaction = total > 0 ? (pattern.feedbackPositive / total * 100).toFixed(0) : null

              return (
                <div key={pattern.name} className="router-report-pattern">
                  <span className="router-report-pattern-rank">#{i + 1}</span>
                  <span className="router-report-pattern-name">{pattern.name.replace(/_/g, ' ')}</span>
                  <span className="router-report-pattern-count">{pattern.count} matches</span>
                  {satisfaction && (
                    <span className={`router-report-pattern-satisfaction ${parseFloat(satisfaction) >= 70 ? 'router-report-pattern-satisfaction--good' : 'router-report-pattern-satisfaction--poor'}`}>
                      {satisfaction}% satisfied
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Recommendations */}
      <div className="router-report-recommendations">
        <h4 className="router-report-section-title">Recommendations</h4>
        <div className="router-report-recommendations-list">
          {parseFloat(metrics.escalationRate) > 15 && (
            <div className="router-report-recommendation router-report-recommendation--warning">
              <span className="router-report-recommendation-icon">⚠️</span>
              <span>High escalation rate ({metrics.escalationRate}%). Consider raising confidence thresholds.</span>
            </div>
          )}
          {parseFloat(metrics.routingRate) < 40 && (
            <div className="router-report-recommendation">
              <span className="router-report-recommendation-icon">💡</span>
              <span>Low routing rate ({metrics.routingRate}%). Consider lowering thresholds or enabling more patterns.</span>
            </div>
          )}
          {metrics.satisfactionRate !== 'N/A' && parseFloat(metrics.satisfactionRate) < 70 && (
            <div className="router-report-recommendation router-report-recommendation--warning">
              <span className="router-report-recommendation-icon">⚠️</span>
              <span>User satisfaction below 70%. Review patterns with negative feedback.</span>
            </div>
          )}
          {parseFloat(metrics.escalationRate) <= 5 && parseFloat(metrics.routingRate) >= 60 && (
            <div className="router-report-recommendation router-report-recommendation--success">
              <span className="router-report-recommendation-icon">✓</span>
              <span>Smart Router is performing well. Keep monitoring for changes.</span>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="router-report-footer">
        <span>Generated {new Date().toLocaleDateString()}</span>
        <span>•</span>
        <span>Smart Router v2.0</span>
      </div>
    </div>
  )
}

/**
 * TransparencyReportCard - Embeddable summary card for dashboards
 */
export function TransparencyReportCard({ onClick }) {
  const [metrics, setMetrics] = useState(null)

  useEffect(() => {
    const stats = getRouterStats()
    const feedback = getFeedbackStats()

    const totalQueries = stats?.totalQueries || 0
    const routedQueries = stats?.routedQueries || 0
    const positiveF = feedback?.total?.positive || 0
    const negativeF = feedback?.total?.negative || 0
    const totalFeedback = positiveF + negativeF

    setMetrics({
      routingRate: totalQueries > 0 ? (routedQueries / totalQueries * 100).toFixed(0) : 0,
      satisfactionRate: totalFeedback > 0 ? (positiveF / totalFeedback * 100).toFixed(0) : 'N/A'
    })
  }, [])

  if (!metrics) return null

  return (
    <div className="router-report-card" onClick={onClick}>
      <div className="router-report-card-header">
        <span className="router-report-card-icon">📊</span>
        <span className="router-report-card-title">Router Report</span>
      </div>
      <div className="router-report-card-stats">
        <div className="router-report-card-stat">
          <span className="router-report-card-stat-value">{metrics.routingRate}%</span>
          <span className="router-report-card-stat-label">routed</span>
        </div>
        <div className="router-report-card-stat">
          <span className="router-report-card-stat-value">{metrics.satisfactionRate}%</span>
          <span className="router-report-card-stat-label">satisfied</span>
        </div>
      </div>
      <div className="router-report-card-footer">View full report →</div>
    </div>
  )
}

export default TransparencyReport
