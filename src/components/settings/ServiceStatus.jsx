/**
 * ServiceStatus Component
 *
 * Admin panel showing health status of all QuoxCORE services.
 * Shows:
 * - Service health with endpoint verification
 * - Version info and uptime
 * - Diagnostics and fix suggestions
 */

import React, { useState, useEffect, useCallback } from 'react'
import { runFullHealthCheck, diagnoseIssues, SERVICES } from '../../services/healthCheck'
import './ServiceStatus.css'

export default function ServiceStatus() {
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState({})

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await runFullHealthCheck()
      setHealth(result)
    } catch (err) {
      console.error('Health check failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    // Auto-refresh every 30 seconds
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [refresh])

  const toggleExpanded = (key) => {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const issues = health ? diagnoseIssues(health) : []

  return (
    <div className="service-status">
      <div className="service-status-header">
        <h2>Service Status</h2>
        <div className="header-actions">
          {health && (
            <span className={`summary-badge ${health.summary.allCriticalHealthy ? 'healthy' : 'unhealthy'}`}>
              {health.summary.message}
            </span>
          )}
          <button onClick={refresh} disabled={loading} className="refresh-btn">
            {loading ? 'Checking...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Critical Issues Banner */}
      {issues.filter(i => i.severity === 'critical').length > 0 && (
        <div className="issues-banner critical">
          <strong>Critical Issues:</strong>
          <ul>
            {issues.filter(i => i.severity === 'critical').map((issue, i) => (
              <li key={i}>
                <strong>{issue.service}:</strong> {issue.issue}
                <div className="fix-hint">Fix: {issue.fix}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Non-critical Issues */}
      {issues.filter(i => i.severity !== 'critical').length > 0 && (
        <div className="issues-banner warning">
          <strong>Issues:</strong>
          <ul>
            {issues.filter(i => i.severity !== 'critical').map((issue, i) => (
              <li key={i}>
                <strong>{issue.service}:</strong> {issue.issue}
                <div className="fix-hint">Fix: {issue.fix}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Service Cards */}
      <div className="service-grid">
        {health && Object.entries(health.services).map(([key, service]) => (
          <div
            key={key}
            className={`service-card ${service.healthy ? 'healthy' : service.responding ? 'partial' : 'down'}`}
          >
            <div className="service-card-header" onClick={() => toggleExpanded(key)}>
              <div className="service-info">
                <span className={`status-dot ${service.healthy ? 'green' : service.responding ? 'yellow' : 'red'}`} />
                <div>
                  <h3>{service.name}</h3>
                  <span className="service-desc">{service.description}</span>
                </div>
              </div>
              <div className="service-meta">
                {service.version && <span className="version">v{service.version}</span>}
                {service.uptime && <span className="uptime">{formatUptime(service.uptime)}</span>}
                <span className="expand-icon">{expanded[key] ? '▼' : '▶'}</span>
              </div>
            </div>

            {expanded[key] && (
              <div className="service-card-details">
                <div className="detail-row">
                  <span className="label">Port:</span>
                  <span className="value">{service.port}</span>
                </div>
                <div className="detail-row">
                  <span className="label">Critical:</span>
                  <span className="value">{service.critical ? 'Yes' : 'No'}</span>
                </div>

                {service.missingEndpoints.length > 0 && (
                  <div className="missing-endpoints">
                    <strong>Missing Endpoints:</strong>
                    <ul>
                      {service.missingEndpoints.map(ep => (
                        <li key={ep} className="missing">{ep}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {Object.keys(service.endpoints).length > 0 && (
                  <div className="endpoints-list">
                    <strong>Endpoints:</strong>
                    <ul>
                      {Object.entries(service.endpoints).map(([path, ep]) => (
                        <li key={path} className={ep.ok || ep.expected ? 'ok' : 'fail'}>
                          <span className="endpoint-path">{ep.method} {path}</span>
                          <span className="endpoint-status">
                            {ep.ok || ep.expected ? '✓' : '✗'}
                            {ep.status && ` (${ep.status})`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {service.error && (
                  <div className="error-message">
                    <strong>Error:</strong> {service.error}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Last Check Time */}
      {health && (
        <div className="last-check">
          Last checked: {new Date(health.timestamp).toLocaleTimeString()}
        </div>
      )}
    </div>
  )
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
}
