import { useState, useEffect, useCallback } from 'react'
import { getAlerts, getTargets, getSystemOverview } from '../../../services/prometheusClient'
import './monitoring.css'

/**
 * MetricsPanel - Live Prometheus metrics overview
 * Shows CPU, memory, disk usage and active alerts
 */
export function MetricsPanel({ compact = false }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)

  const [overview, setOverview] = useState(null)
  const [alerts, setAlerts] = useState({ firing: [], summary: { firing: 0, critical: 0, warning: 0 } })
  const [targets, setTargets] = useState({ summary: { total: 0, up: 0, down: 0 } })

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const [overviewData, alertsData, targetsData] = await Promise.all([
        getSystemOverview(),
        getAlerts(),
        getTargets()
      ])

      setOverview(overviewData)
      setAlerts(alertsData)
      setTargets(targetsData)
      setLastUpdate(new Date())

      if (overviewData.needsSetup) {
        setError(overviewData.setupHint || 'Prometheus not configured')
      } else if (!overviewData.success) {
        setError('Prometheus connection failed')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30000) // Refresh every 30s
    return () => clearInterval(interval)
  }, [fetchData])

  const getBarColor = (value) => {
    if (value >= 90) return 'red'
    if (value >= 70) return 'yellow'
    return 'green'
  }

  if (compact) {
    return (
      <div className="metrics-compact">
        <div className="metrics-compact-header">
          <span className="metrics-compact-title">METRICS</span>
          {alerts.summary?.firing > 0 && (
            <span className={`metrics-compact-alerts ${alerts.summary?.critical > 0 ? 'critical' : 'warning'}`}>
              {alerts.summary?.firing || 0}
            </span>
          )}
        </div>
        <div className="metrics-compact-stats">
          <div className="metrics-compact-stat">
            <span className="value">{overview?.metrics?.cpu?.avg ?? '-'}%</span>
            <span className="label">CPU</span>
          </div>
          <div className="metrics-compact-stat">
            <span className="value">{overview?.metrics?.memory?.avg ?? '-'}%</span>
            <span className="label">MEM</span>
          </div>
          <div className="metrics-compact-stat">
            <span className="value">{targets.summary?.up ?? 0}/{targets.summary?.total ?? 0}</span>
            <span className="label">UP</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="metrics-panel">
      {/* Header */}
      <div className="metrics-header">
        <div className="metrics-title">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
          <span>Prometheus Metrics</span>
        </div>
        <div className="metrics-actions">
          <button
            className="metrics-refresh"
            onClick={fetchData}
            disabled={loading}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={loading ? 'spinning' : ''}>
              <path d="M21 12a9 9 0 11-6.22-8.56"/><path d="M21 3v6h-6"/>
            </svg>
          </button>
          {lastUpdate && (
            <span className="metrics-updated">
              {lastUpdate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
      </div>

      {loading && !overview && (
        <div className="metrics-loading">Loading metrics...</div>
      )}

      {error && (
        <div className="metrics-error">{error}</div>
      )}

      {overview && overview.metrics && (
        <>
          {/* Targets Status */}
          <div className="metrics-targets">
            <span className={`metrics-target-status ${targets.summary?.down > 0 ? 'warn' : 'ok'}`}>
              {targets.summary?.up ?? 0}/{targets.summary?.total ?? 0} targets up
            </span>
            {targets.summary?.down > 0 && (
              <span className="metrics-target-down">{targets.summary.down} down</span>
            )}
          </div>

          {/* Metric Cards */}
          <div className="metrics-grid">
            <div className="metrics-card">
              <div className="metrics-card-header">
                <span className="metrics-card-label">CPU</span>
                <span className="metrics-card-value">{overview.metrics.cpu?.avg ?? '-'}%</span>
              </div>
              <div className="metrics-card-bar">
                <div
                  className={`metrics-card-bar-fill ${getBarColor(parseFloat(overview.metrics.cpu?.avg) || 0)}`}
                  style={{ width: `${Math.min(100, parseFloat(overview.metrics.cpu?.avg) || 0)}%` }}
                />
              </div>
            </div>

            <div className="metrics-card">
              <div className="metrics-card-header">
                <span className="metrics-card-label">Memory</span>
                <span className="metrics-card-value">{overview.metrics.memory?.avg ?? '-'}%</span>
              </div>
              <div className="metrics-card-bar">
                <div
                  className={`metrics-card-bar-fill ${getBarColor(parseFloat(overview.metrics.memory?.avg) || 0)}`}
                  style={{ width: `${Math.min(100, parseFloat(overview.metrics.memory?.avg) || 0)}%` }}
                />
              </div>
            </div>

            <div className="metrics-card">
              <div className="metrics-card-header">
                <span className="metrics-card-label">Disk</span>
                <span className="metrics-card-value">{overview.metrics.disk?.avg ?? '-'}%</span>
              </div>
              <div className="metrics-card-bar">
                <div
                  className={`metrics-card-bar-fill ${getBarColor(parseFloat(overview.metrics.disk?.avg) || 0)}`}
                  style={{ width: `${Math.min(100, parseFloat(overview.metrics.disk?.avg) || 0)}%` }}
                />
              </div>
            </div>

            <div className="metrics-card alerts">
              <div className="metrics-card-header">
                <span className="metrics-card-label">Alerts</span>
                <span className={`metrics-card-value ${(alerts.summary?.firing || 0) > 0 ? 'alert' : ''}`}>
                  {alerts.summary?.firing || 0}
                </span>
              </div>
              <div className="metrics-alert-breakdown">
                {(alerts.summary?.critical || 0) > 0 && (
                  <span className="critical">{alerts.summary?.critical} critical</span>
                )}
                {(alerts.summary?.warning || 0) > 0 && (
                  <span className="warning">{alerts.summary?.warning} warning</span>
                )}
                {(alerts.summary?.firing || 0) === 0 && (
                  <span className="ok">All clear</span>
                )}
              </div>
            </div>
          </div>

          {/* Active Alerts List */}
          {alerts.firing?.length > 0 && (
            <div className="alerts-section">
              <div className="alerts-header">Active Alerts</div>
              <div className="alerts-list">
                {alerts.firing?.slice(0, 5).map((alert, i) => (
                  <div key={i} className={`alert-item ${alert.labels?.severity || 'warning'}`}>
                    <span className={`alert-item-severity ${alert.labels?.severity || 'warning'}`} />
                    <span className="alert-item-name">{alert.labels?.alertname}</span>
                    <span className="alert-item-target">
                      {alert.labels?.instance || alert.labels?.job}
                    </span>
                  </div>
                ))}
                {(alerts.firing?.length || 0) > 5 && (
                  <div className="alerts-more">+{(alerts.firing?.length || 0) - 5} more alerts</div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default MetricsPanel
