/**
 * DockerDashboard
 * Main Docker Fleet plugin dashboard.
 * Phase 1: Fleet overview with auto-discovery and container grid.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { scanFleet, listContainers, containerAction } from '../../services/dockerClient'

// Status colour mapping
const STATUS_COLORS = {
  running: '#34d399',
  exited: '#f87171',
  paused: '#fbbf24',
  restarting: '#60a5fa',
  created: 'rgba(255,255,255,0.65)',
  dead: '#ef4444',
  removing: '#f97316'
}

function getStatusColor(status) {
  const key = (status || '').toLowerCase().split(' ')[0]
  return STATUS_COLORS[key] || 'rgba(255,255,255,0.3)'
}

function parseUptime(status) {
  if (!status) return ''
  const match = status.match(/Up\s+(.+)/i)
  return match ? match[1] : status
}

function formatScanTime(ts) {
  if (!ts) return null
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function DockerDashboard({ onStateChange }) {
  const [hosts, setHosts] = useState([])
  const [containers, setContainers] = useState([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState(null)
  const [selectedHost, setSelectedHost] = useState(null) // null = all hosts
  const [showStopped, setShowStopped] = useState(true)
  const [sortBy, setSortBy] = useState('host')
  const [sortDir, setSortDir] = useState('asc')
  const [actionInProgress, setActionInProgress] = useState(null)
  const [notification, setNotification] = useState(null)
  const [lastScan, setLastScan] = useState(null)
  const [cached, setCached] = useState(false)
  const mountedRef = useRef(false)

  // Notify parent of state changes for sidebar
  useEffect(() => {
    onStateChange?.({ hosts, containers, selectedHost })
  }, [hosts, containers, selectedHost, onStateChange])

  const showNotify = useCallback((msg, type = 'info') => {
    setNotification({ msg, type })
    setTimeout(() => setNotification(null), 4000)
  }, [])

  // Apply fleet result (from cache or live)
  const applyFleet = useCallback((result) => {
    if (result.success && result.hosts) {
      setHosts(result.hosts)
      setCached(!!result.cached)
      if (result.scannedAt) setLastScan(new Date(result.scannedAt))
    } else if (!result.cached) {
      setError(result.error || 'Failed to scan fleet')
    }
  }, [])

  // Apply containers result
  const applyContainers = useCallback((result) => {
    if (result.success && result.containers) {
      setContainers(result.containers)
    } else if (result.error && !result.cached) {
      showNotify(result.error, 'error')
    }
  }, [showNotify])

  // Load cached data (fast, no spinner if cache has data)
  const loadCached = useCallback(async () => {
    try {
      const [fleetResult, containerResult] = await Promise.all([
        scanFleet(),
        listContainers(null, showStopped)
      ])
      applyFleet(fleetResult)
      applyContainers(containerResult)
      // Only clear loading if we got real data from cache
      if (containerResult.success && containerResult.containers?.length > 0) {
        setLoading(false)
      }
    } catch { /* silent */ }
  }, [showStopped, applyFleet, applyContainers])

  // Refresh live data from hosts — fleet scan MUST finish before container list
  const refreshLive = useCallback(async (host = null) => {
    setScanning(true)
    setError(null)
    try {
      // Fleet scan first — discovers hosts
      const fleetResult = await scanFleet({ refresh: true })
      applyFleet(fleetResult)
      // Then list containers (needs hosts to be discovered)
      const containerResult = await listContainers(host, showStopped, { refresh: true })
      applyContainers(containerResult)
    } catch (err) {
      setError(err.message)
    } finally {
      setScanning(false)
      setLoading(false)
    }
  }, [showStopped, applyFleet, applyContainers])

  // On mount: load cache instantly, then refresh in background
  useEffect(() => {
    loadCached().then(() => refreshLive()).then(() => { mountedRef.current = true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // When host filter or showStopped changes, fetch containers for that filter
  // Skip on initial mount — the mount effect handles that
  useEffect(() => {
    if (!mountedRef.current) return
    async function reload() {
      setLoading(true)
      try {
        const result = await listContainers(selectedHost, showStopped, { refresh: true })
        applyContainers(result)
      } catch (err) {
        showNotify(err.message, 'error')
      } finally {
        setLoading(false)
      }
    }
    reload()
  }, [selectedHost, showStopped]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAction = async (host, containerId, action) => {
    const key = `${host}:${containerId}:${action}`
    if (action === 'remove' && !window.confirm(`Remove container ${containerId} on ${host}?`)) return
    setActionInProgress(key)
    try {
      const result = await containerAction(host, containerId, action)
      if (result.success) {
        showNotify(`${action} succeeded on ${containerId}`, 'success')
        // Refresh containers after action
        const result = await listContainers(selectedHost, showStopped, { refresh: true })
        applyContainers(result)
      } else {
        showNotify(result.error || `${action} failed`, 'error')
      }
    } catch (err) {
      showNotify(err.message, 'error')
    } finally {
      setActionInProgress(null)
    }
  }

  // Sort containers
  const sorted = [...containers].sort((a, b) => {
    let va = a[sortBy] || ''
    let vb = b[sortBy] || ''
    if (typeof va === 'string') va = va.toLowerCase()
    if (typeof vb === 'string') vb = vb.toLowerCase()
    if (va < vb) return sortDir === 'asc' ? -1 : 1
    if (va > vb) return sortDir === 'asc' ? 1 : -1
    return 0
  })

  const toggleSort = (col) => {
    if (sortBy === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(col)
      setSortDir('asc')
    }
  }

  // Stats
  const totalRunning = containers.filter(c => (c.state || c.status || '').toLowerCase().startsWith('running')).length
  const totalStopped = containers.length - totalRunning

  return (
    <div className="docker-dashboard">
      <style>{styles}</style>

      {/* Notification */}
      {notification && (
        <div className={`dd-toast dd-toast--${notification.type}`}>
          {notification.msg}
        </div>
      )}

      {/* Header */}
      <div className="dd-header">
        <div className="dd-header__left">
          <div className="dd-header__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="#2496ed" strokeWidth="1.5" style={{ width: 24, height: 24 }}>
              <rect x="2" y="12" width="4" height="4" rx="0.5" />
              <rect x="7" y="12" width="4" height="4" rx="0.5" />
              <rect x="12" y="12" width="4" height="4" rx="0.5" />
              <rect x="7" y="7" width="4" height="4" rx="0.5" />
              <rect x="12" y="7" width="4" height="4" rx="0.5" />
              <rect x="12" y="2" width="4" height="4" rx="0.5" />
              <path d="M2 16c0 2 1.5 4 6 5s8 .5 12-1c2-.75 3-2 3-4" />
            </svg>
          </div>
          <div>
            <h1 className="dd-header__title">Docker Fleet</h1>
            <span className="dd-header__sub">
              {hosts.length} host{hosts.length !== 1 ? 's' : ''} &middot; {containers.length} container{containers.length !== 1 ? 's' : ''} ({totalRunning} running)
            </span>
          </div>
        </div>
        <div className="dd-header__actions">
          {lastScan && (
            <span className="dd-last-scan" title={cached ? 'Showing cached data' : 'Live data'}>
              {cached ? '● ' : ''}Last scan: {formatScanTime(lastScan)}
            </span>
          )}
          <button className="dd-btn dd-btn--ghost" onClick={() => refreshLive(selectedHost)} disabled={scanning}>
            <span style={{ fontSize: 14 }}>↻</span>
            {scanning ? 'Scanning...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Host cards */}
      {hosts.length > 0 && (
        <div className="dd-hosts">
          <button
            className={`dd-host-card ${selectedHost === null ? 'dd-host-card--active' : ''}`}
            onClick={() => setSelectedHost(null)}
          >
            <span className="dd-host-card__name">All Hosts</span>
            <span className="dd-host-card__count">{containers.length}</span>
          </button>
          {hosts.map(h => (
            <button
              key={h.id}
              className={`dd-host-card ${selectedHost === h.id ? 'dd-host-card--active' : ''}`}
              onClick={() => setSelectedHost(h.id)}
            >
              <div className="dd-host-card__dot" style={{ background: h.docker_version ? '#34d399' : '#ef4444' }} />
              <span className="dd-host-card__name">{h.id}</span>
              <span className="dd-host-card__count">
                {h.containers_running || 0}/{h.containers_total || 0}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="dd-error">
          <svg viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" style={{ width: 18, height: 18, flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{error}</span>
          <button className="dd-btn dd-btn--small" onClick={() => { setError(null); refreshLive(selectedHost) }}>
            Retry
          </button>
        </div>
      )}

      {/* Controls */}
      <div className="dd-controls">
        <label className="dd-toggle">
          <input type="checkbox" checked={showStopped} onChange={e => setShowStopped(e.target.checked)} />
          <span className="dd-toggle__label">Show stopped</span>
        </label>
        <div className="dd-stats-strip">
          <span className="dd-stat">
            <span className="dd-stat__dot" style={{ background: '#34d399' }} />
            {totalRunning} running
          </span>
          <span className="dd-stat">
            <span className="dd-stat__dot" style={{ background: '#f87171' }} />
            {totalStopped} stopped
          </span>
        </div>
      </div>

      {/* Container table */}
      {loading && containers.length === 0 ? (
        <div className="dd-loading">
          <div className="dd-spinner" />
          <span>Discovering containers...</span>
        </div>
      ) : containers.length === 0 ? (
        <div className="dd-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="#3f3f46" strokeWidth="1.5" style={{ width: 48, height: 48 }}>
            <rect x="2" y="12" width="4" height="4" rx="0.5" />
            <rect x="7" y="12" width="4" height="4" rx="0.5" />
            <rect x="12" y="12" width="4" height="4" rx="0.5" />
            <path d="M2 16c0 2 1.5 4 6 5s8 .5 12-1c2-.75 3-2 3-4" />
          </svg>
          <h3>No containers found</h3>
          <p>Run a fleet scan to discover Docker hosts and containers.</p>
          <button className="dd-btn dd-btn--primary" onClick={() => refreshLive()}>
            Scan Fleet
          </button>
        </div>
      ) : (
        <div className="dd-table-wrap">
          <table className="dd-table">
            <thead>
              <tr>
                {[
                  { key: 'name', label: 'Container' },
                  { key: 'image', label: 'Image' },
                  { key: 'status', label: 'Status' },
                  { key: 'host', label: 'Host' },
                  { key: 'ports', label: 'Ports' },
                  { key: 'created', label: 'Uptime' }
                ].map(col => (
                  <th key={col.key} onClick={() => toggleSort(col.key)} className="dd-th--sortable">
                    {col.label}
                    {sortBy === col.key && (
                      <span className="dd-sort-arrow">{sortDir === 'asc' ? ' \u2191' : ' \u2193'}</span>
                    )}
                  </th>
                ))}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(c => {
                const isRunning = (c.state || c.status || '').toLowerCase().startsWith('running')
                const actionKey = `${c.host}:${c.id}`
                return (
                  <tr key={`${c.host}-${c.id}`} className={isRunning ? '' : 'dd-row--stopped'}>
                    <td className="dd-cell--name">
                      <span className="dd-name-dot" style={{ background: getStatusColor(c.state || c.status) }} />
                      {c.name || c.names || c.id?.slice(0, 12)}
                    </td>
                    <td className="dd-cell--image">{(c.image || '').split('@')[0]}</td>
                    <td>
                      <span className="dd-status-badge" style={{ color: getStatusColor(c.state || c.status) }}>
                        {(c.state || c.status || 'unknown').split(' ')[0]}
                      </span>
                    </td>
                    <td className="dd-cell--host">{c.host}</td>
                    <td className="dd-cell--ports">{c.ports || '-'}</td>
                    <td className="dd-cell--uptime">{parseUptime(c.status)}</td>
                    <td className="dd-cell--actions">
                      {isRunning ? (
                        <>
                          <button
                            className="dd-action-btn"
                            title="Restart"
                            disabled={actionInProgress === `${actionKey}:restart`}
                            onClick={() => handleAction(c.host, c.name || c.id, 'restart')}
                          >
                            <span className="dd-action-icon">↻</span>
                          </button>
                          <button
                            className="dd-action-btn dd-action-btn--warn"
                            title="Stop"
                            disabled={actionInProgress === `${actionKey}:stop`}
                            onClick={() => handleAction(c.host, c.name || c.id, 'stop')}
                          >
                            <span className="dd-action-icon">■</span>
                          </button>
                        </>
                      ) : (
                        <button
                          className="dd-action-btn dd-action-btn--start"
                          title="Start"
                          disabled={actionInProgress === `${actionKey}:start`}
                          onClick={() => handleAction(c.host, c.name || c.id, 'start')}
                        >
                          <span className="dd-action-icon">▶</span>
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const styles = `
.docker-dashboard {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 1400px;
  position: relative;
}

/* Toast */
.dd-toast {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 9999;
  padding: 12px 20px;
  border-radius: 10px;
  font-size: 0.85rem;
  font-weight: 500;
  animation: ddFadeIn 0.3s ease;
  backdrop-filter: var(--glass-blur);
}
.dd-toast--success { background: rgba(52,211,153,0.15); border: 1px solid rgba(52,211,153,0.3); color: #6ee7b7; }
.dd-toast--error { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; }
.dd-toast--info { background: rgba(96,165,250,0.15); border: 1px solid rgba(96,165,250,0.3); color: #93c5fd; }

@keyframes ddFadeIn {
  from { opacity: 0; transform: translateY(-12px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Header */
.dd-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.dd-header__left {
  display: flex;
  align-items: center;
  gap: 14px;
}
.dd-header__icon {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  background: rgba(36,150,237,0.1);
  border: 1px solid rgba(36,150,237,0.2);
  display: flex;
  align-items: center;
  justify-content: center;
}
.dd-header__title {
  margin: 0;
  font-size: 1.4rem;
  font-weight: 700;
  color: #f4f4f5;
  letter-spacing: -0.01em;
}
.dd-header__sub {
  font-size: 0.8rem;
  color: rgba(255,255,255,0.4);
}

/* Buttons */
.dd-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 0.825rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid;
  white-space: nowrap;
}
.dd-btn--ghost {
  background: rgba(255,255,255,0.04);
  border-color: rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.6);
}
.dd-btn--ghost:hover:not(:disabled) {
  background: rgba(255,255,255,0.08);
  color: #e4e4e7;
}
.dd-btn--ghost:disabled { opacity: 0.5; cursor: not-allowed; }
.dd-btn--primary {
  background: linear-gradient(135deg, #2496ed, #1a7fd4);
  border-color: transparent;
  color: white;
}
.dd-btn--primary:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(36,150,237,0.3); }
.dd-btn--small {
  padding: 5px 12px;
  font-size: 0.75rem;
  border-radius: 6px;
  background: rgba(255,255,255,0.05);
  border-color: rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.6);
}

/* Host cards */
.dd-hosts {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.dd-host-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  color: rgba(255,255,255,0.6);
  font-size: 0.825rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}
.dd-host-card:hover {
  background: rgba(255,255,255,0.06);
  border-color: rgba(255,255,255,0.15);
  color: #e4e4e7;
}
.dd-host-card--active {
  background: rgba(36,150,237,0.08);
  border-color: rgba(36,150,237,0.25);
  color: #60a5fa;
}
.dd-host-card__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dd-host-card__name { font-weight: 600; }
.dd-host-card__count {
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  color: rgba(255,255,255,0.3);
  padding: 1px 6px;
  background: rgba(255,255,255,0.05);
  border-radius: 4px;
}
.dd-host-card--active .dd-host-card__count {
  background: rgba(36,150,237,0.15);
  color: #60a5fa;
}

/* Error */
.dd-error {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(239,68,68,0.06);
  border: 1px solid rgba(239,68,68,0.15);
  border-radius: 10px;
  color: #fca5a5;
  font-size: 0.85rem;
}

/* Controls */
.dd-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.dd-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 0.8rem;
  color: rgba(255,255,255,0.4);
}
.dd-toggle input { accent-color: #2496ed; }
.dd-toggle__label { user-select: none; }
.dd-stats-strip {
  display: flex;
  gap: 16px;
  background: transparent;
  border-bottom: 1px solid rgba(255,255,255,0.12);
}
.dd-stat {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.8rem;
  color: rgba(255,255,255,0.4);
}
.dd-stat__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

/* Table */
.dd-table-wrap {
  overflow-x: auto;
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 12px;
  background: rgba(255,255,255,0.02);
}
.dd-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.825rem;
}
.dd-table th {
  text-align: left;
  padding: 10px 14px;
  font-size: 0.7rem;
  font-weight: 600;
  color: #fff;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.35)), var(--m-bg-base);
  border-bottom: 1px solid rgba(255,255,255,0.12);
  white-space: nowrap;
}
.dd-th--sortable { cursor: pointer; user-select: none; }
.dd-th--sortable:hover { color: rgba(255,255,255,0.6); }
.dd-sort-arrow { font-size: 0.65rem; }
.dd-table td {
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  color: #d4d4d8;
  white-space: nowrap;
}
.dd-table tr:last-child td { border-bottom: none; }
.dd-table tr:hover { background: rgba(255,255,255,0.02); }
.dd-row--stopped td { opacity: 0.55; }
.dd-row--stopped:hover td { opacity: 0.75; }
.dd-cell--name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #f4f4f5;
}
.dd-name-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dd-cell--image {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  color: rgba(255,255,255,0.6);
}
.dd-status-badge {
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: capitalize;
}
.dd-cell--host {
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  color: #60a5fa;
}
.dd-cell--ports {
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  color: rgba(255,255,255,0.4);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dd-cell--uptime {
  font-size: 0.75rem;
  color: rgba(255,255,255,0.4);
}
.dd-cell--actions {
  display: flex;
  gap: 4px;
}

/* Last scan timestamp */
.dd-last-scan {
  font-size: 0.75rem;
  color: rgba(255,255,255,0.4);
  white-space: nowrap;
}

/* Action buttons */
.dd-action-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.04);
  color: rgba(255,255,255,0.75);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.dd-action-icon {
  font-size: 13px;
  line-height: 1;
}
.dd-action-btn:hover:not(:disabled) {
  background: rgba(255,255,255,0.1);
  color: #f4f4f5;
  border-color: rgba(255,255,255,0.2);
}
.dd-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.dd-action-btn--warn:hover:not(:disabled) {
  background: rgba(239,68,68,0.1);
  border-color: rgba(239,68,68,0.25);
  color: #f87171;
}
.dd-action-btn--start:hover:not(:disabled) {
  background: rgba(52,211,153,0.1);
  border-color: rgba(52,211,153,0.25);
  color: #34d399;
}

/* Loading */
.dd-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 64px 40px;
  color: rgba(255,255,255,0.4);
  font-size: 0.9rem;
}
.dd-spinner {
  width: 36px;
  height: 36px;
  border: 2px solid rgba(36,150,237,0.15);
  border-top-color: #2496ed;
  border-radius: 50%;
  animation: ddSpin 0.8s linear infinite;
}
@keyframes ddSpin { to { transform: rotate(360deg); } }

/* Empty */
.dd-empty {
  text-align: center;
  padding: 56px 40px;
  background: rgba(255,255,255,0.015);
  border: 1px dashed rgba(255,255,255,0.08);
  border-radius: 14px;
}
.dd-empty h3 {
  margin: 16px 0 6px;
  font-size: 1rem;
  color: rgba(255,255,255,0.6);
  font-weight: 600;
}
.dd-empty p {
  margin: 0 0 20px;
  color: rgba(255,255,255,0.3);
  font-size: 0.85rem;
}

/* Responsive */
@media (max-width: 768px) {
  .dd-header { flex-direction: column; align-items: flex-start; }
  .dd-hosts { overflow-x: auto; flex-wrap: nowrap; }
  .dd-table { font-size: 0.75rem; }
}
`
