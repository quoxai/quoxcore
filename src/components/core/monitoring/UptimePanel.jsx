import { useState, useEffect, useCallback, useRef } from 'react'
import { getStatus, getConfiguredPages, formatPing } from '../../../services/uptimeKumaClient'
import './monitoring.css'

/**
 * UptimePanel - Live Uptime Kuma service status with multi-page tabs
 * Loads cached data instantly on mount, then refreshes in background.
 * Manual refresh via button, auto-refresh every 60s.
 */
export function UptimePanel({ compact = false, onAddPage, onReconfigure }) {
  const [pages, setPages] = useState([])
  const [activeTab, setActiveTab] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [status, setStatus] = useState(null)
  const [cached, setCached] = useState(false)
  const initialLoadDone = useRef(false)

  // Load configured pages on mount
  useEffect(() => {
    getConfiguredPages().then(p => {
      setPages(p)
      if (p.length > 0 && !activeTab) setActiveTab(p[0].slug)
    })
  }, [])

  // Apply status data from any fetch
  const applyData = useCallback((data) => {
    setStatus(data)
    setCached(!!data.cached)
    if (data.scannedAt) {
      setLastUpdate(new Date(data.scannedAt))
    } else {
      setLastUpdate(new Date())
    }

    if (data.needsStatusPage) {
      setError('No status pages configured. Add a status page to get started.')
    } else if (data.needsSetup) {
      setError(data.setupHint || 'Uptime Kuma not configured')
    } else if (!data.success) {
      setError(data.error || 'Failed to fetch status')
    } else if (data.summary?.total === 0) {
      setError('Status page has no monitors. Add monitors to your status page in Uptime Kuma, then refresh here.')
    } else {
      setError(null)
    }
  }, [])

  // Load cached data (fast, no spinner)
  const loadCached = useCallback(async (slug) => {
    const targetSlug = slug || activeTab
    if (!targetSlug) return
    try {
      const data = await getStatus(targetSlug) // hits cache by default
      applyData(data)
    } catch {
      // Silently fail — will try refresh next
    }
  }, [activeTab, applyData])

  // Refresh from Kuma (shows spinner, updates cache)
  const refreshData = useCallback(async (slug) => {
    const targetSlug = slug || activeTab
    if (!targetSlug) return
    try {
      setLoading(true)
      const data = await getStatus(targetSlug, { refresh: true })
      applyData(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [activeTab, applyData])

  // On tab change: load cache instantly, then refresh in background
  useEffect(() => {
    if (!activeTab) return

    // Load cached data immediately (no spinner)
    loadCached(activeTab).then(() => {
      initialLoadDone.current = true
      // Then refresh in background
      refreshData(activeTab)
    })

    // Auto-refresh every 60s
    const interval = setInterval(() => refreshData(activeTab), 60000)
    return () => clearInterval(interval)
  }, [activeTab])

  const getStatusColor = (statusCode) => {
    switch (statusCode) {
      case 1: return '#30ff90'
      case 0: return '#38bdf8'
      case 2: return '#ffb030'
      case 3: return 'rgba(255,255,255,0.4)'
      default: return 'rgba(255,255,255,0.3)'
    }
  }

  const getStatusLabel = (statusCode) => {
    switch (statusCode) {
      case 1: return 'UP'
      case 0: return 'DOWN'
      case 2: return 'PENDING'
      case 3: return 'MAINT'
      default: return '?'
    }
  }

  if (compact) {
    return (
      <div className="uptime-compact">
        <div className="uptime-compact-header">
          <span className="uptime-compact-title">UPTIME</span>
          {status?.summary?.down > 0 && (
            <span className="uptime-compact-down">{status.summary.down} DOWN</span>
          )}
        </div>
        <div className="uptime-compact-stats">
          <div className="uptime-compact-stat">
            <span className="value" style={{ color: '#30ff90' }}>{status?.summary?.up || 0}</span>
            <span className="label">Up</span>
          </div>
          <div className="uptime-compact-stat">
            <span className="value" style={{ color: '#38bdf8' }}>{status?.summary?.down || 0}</span>
            <span className="label">Down</span>
          </div>
          <div className="uptime-compact-stat">
            <span className="value">{status?.summary?.total || 0}</span>
            <span className="label">Total</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="uptime-panel">
      {/* Header */}
      <div className="uptime-header">
        <div className="uptime-title">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/>
          </svg>
          <span>Uptime Kuma</span>
        </div>
        <div className="uptime-actions">
          <button
            className="uptime-refresh"
            onClick={() => refreshData(activeTab)}
            disabled={loading}
            title="Refresh from Kuma"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={loading ? 'spinning' : ''}>
              <path d="M21 12a9 9 0 11-6.22-8.56"/><path d="M21 3v6h-6"/>
            </svg>
          </button>
          {lastUpdate && (
            <span className="uptime-updated" title={cached ? 'Showing cached data' : 'Live data'}>
              {cached && '● '}
              {lastUpdate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {onReconfigure && (
            <button
              className="uptime-refresh"
              onClick={onReconfigure}
              title="Connection settings"
            >
              <span style={{ fontSize: 14, color: error ? '#ff4444' : 'rgba(255,255,255,0.5)' }}>⚙</span>
            </button>
          )}
        </div>
      </div>

      {/* Tabs — only show when multiple pages */}
      {pages.length > 1 && (
        <div className="uptime-tabs">
          {pages.map(page => (
            <button
              key={page.slug}
              className={`uptime-tab ${activeTab === page.slug ? 'active' : ''}`}
              onClick={() => setActiveTab(page.slug)}
            >
              {page.label}
            </button>
          ))}
          {onAddPage && (
            <button className="uptime-tab uptime-tab-add" onClick={onAddPage} title="Add status page">
              +
            </button>
          )}
        </div>
      )}

      {/* Single page with add button */}
      {pages.length === 1 && onAddPage && (
        <div className="uptime-tabs">
          <button className="uptime-tab active">{pages[0].label}</button>
          <button className="uptime-tab uptime-tab-add" onClick={onAddPage} title="Add status page">
            +
          </button>
        </div>
      )}

      {loading && !status && (
        <div className="uptime-loading">Loading service status...</div>
      )}

      {error && (
        <div className="uptime-error">{error}</div>
      )}

      {status?.success && (
        <>
          {/* Summary */}
          <div className="uptime-summary">
            <div className={`uptime-health ${status.summary.down > 0 ? 'degraded' : 'ok'}`}>
              <span className="uptime-health-icon">
                {status.summary.down > 0 ? '●' : '●'}
              </span>
              <span className="uptime-health-text">
                {status.summary.down > 0
                  ? `${status.summary.down} SERVICE${status.summary.down > 1 ? 'S' : ''} DOWN`
                  : 'ALL SERVICES OPERATIONAL'}
              </span>
            </div>
            <div className="uptime-counts">
              <span className="uptime-count up">{status.summary.up} up</span>
              {status.summary.down > 0 && (
                <span className="uptime-count down">{status.summary.down} down</span>
              )}
              {status.summary.maintenance > 0 && (
                <span className="uptime-count maint">{status.summary.maintenance} maint</span>
              )}
            </div>
          </div>

          {/* Down Services (always show first) */}
          {status.monitors?.filter(m => m.status === 0).length > 0 && (
            <div className="uptime-down-list">
              <div className="uptime-section-label">DOWN SERVICES</div>
              {status.monitors?.filter(m => m.status === 0).map(monitor => (
                <div key={monitor.id} className="uptime-item down">
                  <span className="uptime-item-status" style={{ background: '#38bdf8' }} />
                  <div className="uptime-item-info">
                    <span className="uptime-item-name">{monitor.name || `Monitor ${monitor.id}`}</span>
                    <span className="uptime-item-message">{monitor.message || 'Service unavailable'}</span>
                  </div>
                  <span className="uptime-item-uptime">{monitor.uptime24h}%</span>
                </div>
              ))}
            </div>
          )}

          {/* All Services */}
          <div className="uptime-list">
            <div className="uptime-section-label">ALL SERVICES ({status.summary.total})</div>
            {status.monitors?.map(monitor => (
              <div key={monitor.id} className={`uptime-item ${monitor.status === 1 ? 'up' : monitor.status === 0 ? 'down' : 'other'}`}>
                <span
                  className="uptime-item-status"
                  style={{ background: getStatusColor(monitor.status) }}
                />
                <div className="uptime-item-info">
                  <span className="uptime-item-name">{monitor.name || `Monitor ${monitor.id}`}</span>
                  {monitor.group && (
                    <span className="uptime-item-group">{monitor.group}</span>
                  )}
                </div>
                <div className="uptime-item-stats">
                  <span className="uptime-item-ping">{formatPing(monitor.ping)}</span>
                  <span className="uptime-item-uptime">{monitor.uptime24h}%</span>
                  <span className={`uptime-item-badge ${getStatusLabel(monitor.status).toLowerCase()}`}>
                    {getStatusLabel(monitor.status)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default UptimePanel
