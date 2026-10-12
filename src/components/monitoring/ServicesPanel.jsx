import { useState, useEffect, useCallback } from 'react'
import { runFullHealthCheck, SERVICES } from '../../services/healthCheck'
import '../core/monitoring/monitoring.css'

/**
 * ServicesPanel - Services Status Widget
 * Shows health status of all registered services with ports
 */
export function ServicesPanel({ compact = false }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [healthResult, setHealthResult] = useState(null)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const result = await runFullHealthCheck()
      setHealthResult(result)
      setLastUpdate(new Date())
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

  const services = healthResult?.services || {}
  const summary = healthResult?.summary || { healthy: 0, unhealthy: 0, total: 0 }

  // Calculate degraded count (responding but missing endpoints)
  const degradedCount = Object.values(services).filter(
    s => s.responding && !s.healthy
  ).length

  if (compact) {
    return (
      <div className="services-compact">
        <div className="services-compact-header">
          <span className="services-compact-title">SERVICES</span>
          {summary.unhealthy > 0 && (
            <span className="services-compact-alert critical">
              {summary.unhealthy}
            </span>
          )}
        </div>
        <div className="services-compact-stats">
          <div className="services-compact-stat">
            <span className="value" style={{ color: '#30ff90' }}>{summary.healthy}</span>
            <span className="label">Up</span>
          </div>
          <div className="services-compact-stat">
            <span className="value" style={{ color: '#ffb030' }}>{degradedCount}</span>
            <span className="label">Warn</span>
          </div>
          <div className="services-compact-stat">
            <span className="value" style={{ color: '#38bdf8' }}>{summary.unhealthy - degradedCount}</span>
            <span className="label">Down</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="services-panel">
      {/* Header */}
      <div className="services-header">
        <div className="services-title">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
          </svg>
          <span>Services Status</span>
        </div>
        <div className="services-actions">
          <button
            className="services-refresh"
            onClick={fetchData}
            disabled={loading}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={loading ? 'spinning' : ''}>
              <path d="M21 12a9 9 0 11-6.22-8.56"/><path d="M21 3v6h-6"/>
            </svg>
          </button>
          {lastUpdate && (
            <span className="services-updated">
              {lastUpdate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
      </div>

      {loading && !healthResult && (
        <div className="services-loading">Checking services...</div>
      )}

      {error && (
        <div className="services-error">{error}</div>
      )}

      {healthResult && (
        <>
          {/* Summary */}
          <div className="services-summary">
            <span className={`services-summary-status ${summary.allHealthy ? 'ok' : 'warn'}`}>
              {summary.allHealthy ? '● All Systems Operational' : `● ${summary.unhealthy} Issue${summary.unhealthy > 1 ? 's' : ''}`}
            </span>
            <span className="services-summary-count">
              {summary.healthy}/{summary.total} healthy
            </span>
          </div>

          {/* Services List */}
          <div className="services-list">
            {Object.entries(services).map(([key, service]) => {
              const status = service.healthy ? 'healthy' :
                            service.responding ? 'degraded' : 'unhealthy'
              const showDocsLink = !service.healthy && service.docsUrl
              return (
                <div key={key} className={`services-item ${status}`}>
                  <div className={`services-item-status ${status}`} />
                  <div className="services-item-info">
                    <span className="services-item-name">{service.name}</span>
                    <span className="services-item-desc">{service.description}</span>
                    {showDocsLink && (
                      <a
                        href={service.docsUrl}
                        className="services-item-docs-link"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                        </svg>
                        PROBLEM SOLVE
                      </a>
                    )}
                  </div>
                  <div className="services-item-meta">
                    <span className="services-item-port">:{service.port}</span>
                    {service.critical && (
                      <span className="services-item-critical">CRITICAL</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

export default ServicesPanel
