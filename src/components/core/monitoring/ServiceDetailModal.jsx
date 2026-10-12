import { useState, useEffect } from 'react'
import { getService, getServiceDependencies, getServiceDependents } from '../../../config/serviceRegistry'
import { getServiceUptime, getAverageResponseTime, getResponseTimeTrend, getStatusHistory } from '../../../services/serviceHistory'
import { RestartButton } from './RestartButton'
import './monitoring.css'

/**
 * ServiceDetailModal - Detailed service information modal
 *
 * Shows:
 * - Service overview and status
 * - Response time and uptime metrics
 * - Dependencies and dependents
 * - Troubleshooting tips
 * - Documentation links
 */
export function ServiceDetailModal({ serviceKey, healthData, onClose }) {
  const [activeTab, setActiveTab] = useState('overview')

  const registry = getService(serviceKey)
  const liveData = healthData?.services?.[serviceKey]

  if (!registry || !liveData) {
    return null
  }

  const uptime = getServiceUptime(serviceKey, 24)
  const avgResponseTime = getAverageResponseTime(serviceKey, 1)
  const trend = getResponseTimeTrend(serviceKey, 30)
  const dependencies = getServiceDependencies(serviceKey)
  const dependents = getServiceDependents(serviceKey)

  const status = liveData.healthy ? 'healthy' :
                liveData.responding ? 'degraded' : 'down'

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div className="service-modal-overlay" onClick={handleBackdropClick}>
      <div className="service-modal">
        {/* Header */}
        <div className="service-modal__header">
          <div className="service-modal__title-row">
            <div className={`service-modal__status-dot service-modal__status-dot--${status}`} />
            <h2>{registry.name}</h2>
            <span className="service-modal__port">:{registry.port}</span>
            {registry.critical && (
              <span className="service-modal__critical-badge">CRITICAL</span>
            )}
          </div>
          <button className="service-modal__close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="service-modal__tabs">
          <button
            className={`service-modal__tab ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
            Overview
          </button>
          <button
            className={`service-modal__tab ${activeTab === 'metrics' ? 'active' : ''}`}
            onClick={() => setActiveTab('metrics')}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3v18h18" />
              <path d="M18 9l-5 5-4-4-3 3" />
            </svg>
            Metrics
          </button>
          <button
            className={`service-modal__tab ${activeTab === 'troubleshoot' ? 'active' : ''}`}
            onClick={() => setActiveTab('troubleshoot')}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            Troubleshoot
          </button>
          <button
            className={`service-modal__tab ${activeTab === 'docs' ? 'active' : ''}`}
            onClick={() => setActiveTab('docs')}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            Docs
          </button>
        </div>

        {/* Content */}
        <div className="service-modal__content">
          {activeTab === 'overview' && (
            <div className="service-modal__overview">
              {/* Status Summary */}
              <div className="service-modal__section">
                <h3>Current Status</h3>
                <div className="service-modal__status-grid">
                  <div className="service-modal__status-item">
                    <span className="label">Status</span>
                    <span className={`value value--${status}`}>
                      {status === 'healthy' ? 'Online' :
                       status === 'degraded' ? 'Degraded' : 'Offline'}
                    </span>
                  </div>
                  <div className="service-modal__status-item">
                    <span className="label">Response Time</span>
                    <span className="value">{liveData.responseTime ?? '-'}ms</span>
                  </div>
                  <div className="service-modal__status-item">
                    <span className="label">24h Uptime</span>
                    <span className="value">{uptime !== null ? `${uptime}%` : '-'}</span>
                  </div>
                  <div className="service-modal__status-item">
                    <span className="label">Version</span>
                    <span className="value">{liveData.version || '-'}</span>
                  </div>
                </div>
              </div>

              {/* Actions */}
              {registry.restartable && registry.containerName && (
                <div className="service-modal__section">
                  <h3>Actions</h3>
                  <RestartButton
                    containerName={registry.containerName}
                    serviceName={registry.name}
                  />
                </div>
              )}

              {/* Description */}
              <div className="service-modal__section">
                <h3>Description</h3>
                <p className="service-modal__description">{registry.longDescription}</p>
              </div>

              {/* Dependencies */}
              {(dependencies.length > 0 || dependents.length > 0) && (
                <div className="service-modal__section">
                  <h3>Dependencies</h3>
                  <div className="service-modal__deps">
                    {dependencies.length > 0 && (
                      <div className="service-modal__dep-group">
                        <span className="service-modal__dep-label">Depends on:</span>
                        <div className="service-modal__dep-list">
                          {dependencies.map(dep => (
                            <span key={dep.key} className="service-modal__dep-chip">
                              {dep.shortName}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {dependents.length > 0 && (
                      <div className="service-modal__dep-group">
                        <span className="service-modal__dep-label">Used by:</span>
                        <div className="service-modal__dep-list">
                          {dependents.map(dep => (
                            <span key={dep.key} className="service-modal__dep-chip">
                              {dep.shortName}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'metrics' && (
            <div className="service-modal__metrics">
              {/* Response Time Trend */}
              <div className="service-modal__section">
                <h3>Response Time Trend</h3>
                {trend.length > 0 ? (
                  <div className="service-modal__sparkline">
                    <div className="sparkline-container">
                      {trend.map((point, i) => {
                        const maxValue = Math.max(...trend.map(t => t.value), 100)
                        const height = (point.value / maxValue) * 100
                        return (
                          <div
                            key={i}
                            className={`sparkline-bar sparkline-bar--${point.status}`}
                            style={{ height: `${Math.max(height, 5)}%` }}
                            title={`${point.value}ms`}
                          />
                        )
                      })}
                    </div>
                    <div className="sparkline-labels">
                      <span>Last {trend.length} checks</span>
                      <span>Avg: {avgResponseTime ?? '-'}ms</span>
                    </div>
                  </div>
                ) : (
                  <p className="service-modal__empty">No history data yet</p>
                )}
              </div>

              {/* Thresholds */}
              <div className="service-modal__section">
                <h3>Thresholds</h3>
                <div className="service-modal__thresholds">
                  <div className="threshold-item">
                    <span className="threshold-label">Response Time Warning</span>
                    <span className="threshold-value">{registry.thresholds.responseTime.warning}ms</span>
                  </div>
                  <div className="threshold-item">
                    <span className="threshold-label">Response Time Critical</span>
                    <span className="threshold-value">{registry.thresholds.responseTime.critical}ms</span>
                  </div>
                  <div className="threshold-item">
                    <span className="threshold-label">Uptime Warning</span>
                    <span className="threshold-value">{registry.thresholds.uptimePercent.warning}%</span>
                  </div>
                  <div className="threshold-item">
                    <span className="threshold-label">Uptime Critical</span>
                    <span className="threshold-value">{registry.thresholds.uptimePercent.critical}%</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'troubleshoot' && (
            <div className="service-modal__troubleshoot">
              {registry.troubleshooting.map((item, i) => (
                <div key={i} className="service-modal__trouble-item">
                  <h4>{item.symptom}</h4>
                  <div className="trouble-checks">
                    <span className="trouble-label">Diagnostic checks:</span>
                    <ul>
                      {item.checks.map((check, j) => (
                        <li key={j}><code>{check}</code></li>
                      ))}
                    </ul>
                  </div>
                  <div className="trouble-solution">
                    <span className="trouble-label">Solution:</span>
                    <code>{item.solution}</code>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'docs' && (
            <div className="service-modal__docs">
              <div className="service-modal__section">
                <h3>Configuration</h3>
                <div className="service-modal__doc-items">
                  {registry.docs.configPath && (
                    <div className="doc-item">
                      <span className="doc-label">Config Path</span>
                      <code className="doc-value">{registry.docs.configPath}</code>
                    </div>
                  )}
                  {registry.docs.logsPath && (
                    <div className="doc-item">
                      <span className="doc-label">Logs</span>
                      <code className="doc-value">{registry.docs.logsPath}</code>
                    </div>
                  )}
                  {registry.docs.systemdService && (
                    <div className="doc-item">
                      <span className="doc-label">Systemd Service</span>
                      <code className="doc-value">{registry.docs.systemdService}</code>
                    </div>
                  )}
                  {registry.docs.dockerCompose && (
                    <div className="doc-item">
                      <span className="doc-label">Docker Compose</span>
                      <code className="doc-value">{registry.docs.dockerCompose}</code>
                    </div>
                  )}
                  {registry.docs.serverFile && (
                    <div className="doc-item">
                      <span className="doc-label">Server File</span>
                      <code className="doc-value">{registry.docs.serverFile}</code>
                    </div>
                  )}
                </div>
              </div>

              {registry.links && registry.links.length > 0 && (
                <div className="service-modal__section">
                  <h3>Links</h3>
                  <div className="service-modal__links">
                    {registry.links.map((link, i) => (
                      <a
                        key={i}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="service-modal__link"
                      >
                        {link.label}
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                        </svg>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ServiceDetailModal
