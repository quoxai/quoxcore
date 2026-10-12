import { useState, useEffect } from 'react'
import { getAlerts } from '../../services/prometheusClient'
import { getHealth as getKumaHealth } from '../../services/uptimeKumaClient'
import './safety.css'

/**
 * AlertBadge - Shows live alert status from Prometheus and Uptime Kuma
 */
export function AlertBadge({ refreshInterval = 60000 }) {
  const [alerts, setAlerts] = useState({ firing: 0, critical: 0 })
  const [kumaStatus, setKumaStatus] = useState({ down: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const [details, setDetails] = useState(null)

  // Fetch alerts
  const fetchAlerts = async () => {
    try {
      const [promResult, kumaResult] = await Promise.all([
        getAlerts(),
        getKumaHealth()
      ])

      if (promResult.success) {
        setAlerts({
          firing: promResult.summary.firing,
          critical: promResult.summary.critical,
          warning: promResult.summary.warning,
          alerts: promResult.firing
        })
      }

      if (kumaResult.success) {
        setKumaStatus({
          down: kumaResult.summary?.down || 0,
          total: kumaResult.summary?.total || 0
        })
      }

      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAlerts()
    const interval = setInterval(fetchAlerts, refreshInterval)
    return () => clearInterval(interval)
  }, [refreshInterval])

  const totalIssues = alerts.firing + kumaStatus.down
  const hasCritical = alerts.critical > 0

  // Determine badge color
  const getBadgeClass = () => {
    if (hasCritical) return 'alert-badge-critical'
    if (totalIssues > 0) return 'alert-badge-warning'
    return 'alert-badge-ok'
  }

  // Handle click to show details
  const handleClick = () => {
    if (totalIssues > 0) {
      setExpanded(!expanded)
      if (!expanded) {
        setDetails({
          prometheus: alerts.alerts || [],
          kumaDown: kumaStatus.down
        })
      }
    }
  }

  if (loading) {
    return (
      <div className="alert-badge alert-badge-loading">
        <span className="alert-badge-icon">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
        </span>
        <span className="alert-badge-text">...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="alert-badge alert-badge-error" title={error}>
        <span className="alert-badge-icon">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
        </span>
        <span className="alert-badge-text">ERR</span>
      </div>
    )
  }

  return (
    <div className="alert-badge-container">
      <button
        className={`alert-badge ${getBadgeClass()}`}
        onClick={handleClick}
        title={totalIssues > 0
          ? `${alerts.firing} Prometheus alerts, ${kumaStatus.down} services down`
          : 'All systems operational'}
      >
        <span className="alert-badge-icon">
          {totalIssues > 0 ? (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5"/>
            </svg>
          )}
        </span>
        <span className="alert-badge-text">
          {totalIssues > 0 ? totalIssues : 'OK'}
        </span>
        {hasCritical && <span className="alert-badge-pulse" />}
      </button>

      {/* Expanded details dropdown */}
      {expanded && details && (
        <div className="alert-badge-dropdown">
          <div className="alert-badge-dropdown-header">
            <span>Active Alerts</span>
            <button onClick={() => setExpanded(false)}>&times;</button>
          </div>
          <div className="alert-badge-dropdown-content">
            {details.prometheus.length > 0 ? (
              details.prometheus.slice(0, 5).map((alert, i) => (
                <div key={i} className={`alert-item alert-${alert.labels?.severity || 'warning'}`}>
                  <span className="alert-name">{alert.labels?.alertname || 'Unknown'}</span>
                  <span className="alert-instance">{alert.labels?.instance || ''}</span>
                </div>
              ))
            ) : (
              <div className="alert-item alert-ok">No Prometheus alerts</div>
            )}
            {details.kumaDown > 0 && (
              <div className="alert-item alert-critical">
                {details.kumaDown} Uptime Kuma monitor(s) down
              </div>
            )}
            {details.prometheus.length > 5 && (
              <div className="alert-item alert-more">
                +{details.prometheus.length - 5} more alerts
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default AlertBadge
