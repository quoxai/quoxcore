import { useState, useEffect, useCallback, useRef } from 'react'
import { getVMs, getContainers, getClusterStatus, formatBytes, formatUptime } from '../../../services/proxmoxClient'
import './monitoring.css'

const CACHE_URL = '/collector/api/v1/monitoring/cache/proxmox'

/**
 * Format a relative time string from an ISO date
 */
function timeAgo(isoDate) {
  if (!isoDate) return ''
  const diff = Date.now() - new Date(isoDate).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * ProxmoxPanel - Live Proxmox cluster overview
 *
 * Loads cached data from server on mount (instant display), then refreshes
 * live data in the background. All data persisted server-side — no localStorage.
 */
export function ProxmoxPanel({ onVMClick, compact = false }) {
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [scannedAt, setScannedAt] = useState(null)
  const [hasLiveData, setHasLiveData] = useState(false)
  const [cacheLoaded, setCacheLoaded] = useState(false)

  const [cluster, setCluster] = useState({ summary: { totalNodes: 0, online: 0, quorate: false } })
  const [vms, setVMs] = useState({ vms: [], summary: { total: 0, running: 0, stopped: 0 } })
  const [containers, setContainers] = useState({ containers: [], summary: { total: 0, running: 0, stopped: 0 } })

  const [filter, setFilter] = useState('all')
  const [expandedView, setExpandedView] = useState('vms')
  const mountedRef = useRef(true)

  // Apply data to state (from cache or live)
  const applyData = useCallback((clusterData, vmData, ctData) => {
    setCluster(clusterData)
    setVMs(vmData)
    setContainers(ctData)
  }, [])

  // Save scan results to server-side cache
  const saveToCache = useCallback(async (clusterData, vmData, ctData) => {
    try {
      await fetch(CACHE_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: { cluster: clusterData, vms: vmData, containers: ctData }
        }),
      })
    } catch {
      // Cache save is best-effort
    }
  }, [])

  // Load cached data from server (instant display)
  const loadCache = useCallback(async () => {
    try {
      const resp = await fetch(CACHE_URL)
      const result = await resp.json()
      if (result.success && result.data) {
        const { cluster: c, vms: v, containers: ct } = result.data
        if (c && v && ct) {
          applyData(c, v, ct)
          setScannedAt(result.scannedAt)
          setCacheLoaded(true)
          return true
        }
      }
    } catch {
      // No cache available
    }
    return false
  }, [applyData])

  // Fetch live data from Proxmox API
  const fetchLive = useCallback(async (isBackground = false) => {
    try {
      if (!isBackground) setRefreshing(true)
      setError(null)

      const [clusterData, vmData, ctData] = await Promise.all([
        getClusterStatus(),
        getVMs(),
        getContainers()
      ])

      if (!mountedRef.current) return

      // Detect errors
      if (!clusterData.success) {
        setError(clusterData.error || 'Failed to connect to Proxmox API')
      } else if (!vmData.success) {
        setError(vmData.error || 'Failed to load VM data')
      } else if (clusterData.summary?.totalNodes > 0 && vmData.summary?.total === 0 && ctData.summary?.total === 0) {
        setError('permissionHint')
      }

      applyData(clusterData, vmData, ctData)
      setScannedAt(new Date().toISOString())
      setHasLiveData(true)

      // Persist to server-side cache (only if we got real data)
      if (clusterData.success) {
        saveToCache(clusterData, vmData, ctData)
      }
    } catch (err) {
      if (mountedRef.current) setError(err.message)
    } finally {
      if (mountedRef.current) setRefreshing(false)
    }
  }, [applyData, saveToCache])

  // Mount: load cache first, then refresh live
  useEffect(() => {
    mountedRef.current = true
    let interval

    ;(async () => {
      const hadCache = await loadCache()
      // Always fetch live data (shows as background refresh if cache existed)
      await fetchLive(hadCache)
      // Auto-refresh every 60s
      interval = setInterval(() => fetchLive(true), 60000)
    })()

    return () => {
      mountedRef.current = false
      if (interval) clearInterval(interval)
    }
  }, [loadCache, fetchLive])

  const filteredVMs = vms.vms?.filter(vm => {
    if (filter === 'all') return true
    return vm.status === filter
  }) || []

  const filteredContainers = containers.containers?.filter(ct => {
    if (filter === 'all') return true
    return ct.status === filter
  }) || []

  const getStatusColor = (status) => {
    switch (status) {
      case 'running': return '#30ff90'
      case 'stopped': return '#ff6b30'
      case 'paused': return '#ffb030'
      default: return '#666'
    }
  }

  const handleVMAction = (vm) => {
    if (onVMClick) onVMClick(vm)
  }

  const isInitialLoad = !cacheLoaded && !hasLiveData && refreshing

  if (compact) {
    return (
      <div className="proxmox-compact">
        <div className="proxmox-compact-header">
          <span className="proxmox-compact-title">PROXMOX</span>
          <span className={`proxmox-compact-status ${cluster.summary?.quorate ? 'ok' : 'warn'}`}>
            {cluster.summary?.quorate ? 'QUORATE' : 'NO QUORUM'}
          </span>
        </div>
        <div className="proxmox-compact-stats">
          <div className="proxmox-compact-stat">
            <span className="value">{cluster.summary?.online ?? 0}/{cluster.summary?.totalNodes ?? 0}</span>
            <span className="label">Nodes</span>
          </div>
          <div className="proxmox-compact-stat">
            <span className="value" style={{ color: '#30ff90' }}>{vms.summary?.running ?? 0}</span>
            <span className="label">VMs</span>
          </div>
          <div className="proxmox-compact-stat">
            <span className="value" style={{ color: '#30ff90' }}>{containers.summary?.running ?? 0}</span>
            <span className="label">CTs</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="proxmox-panel">
      {/* Header */}
      <div className="proxmox-header">
        <div className="proxmox-title">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <span>Proxmox Cluster</span>
        </div>
        <div className="proxmox-actions">
          <button
            className="proxmox-refresh"
            onClick={() => fetchLive(false)}
            disabled={refreshing}
            title="Refresh data"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={refreshing ? 'spinning' : ''}>
              <path d="M21 12a9 9 0 11-6.22-8.56"/><path d="M21 3v6h-6"/>
            </svg>
          </button>
          {scannedAt && (
            <span className="proxmox-updated" title={`Last scan: ${new Date(scannedAt).toLocaleString()}`}>
              {refreshing ? 'Updating...' : timeAgo(scannedAt)}
            </span>
          )}
        </div>
      </div>

      {/* Cluster Status */}
      <div className="proxmox-cluster">
        <div className={`proxmox-quorum ${cluster.summary?.quorate ? 'ok' : 'danger'}`}>
          <span className="proxmox-quorum-icon">
            {cluster.summary?.quorate ? '●' : '○'}
          </span>
          <span className="proxmox-quorum-text">
            {cluster.summary?.quorate ? 'QUORUM OK' : 'NO QUORUM'}
          </span>
        </div>
        <div className="proxmox-nodes">
          <span className="proxmox-nodes-count">
            {cluster.summary?.online ?? 0}/{cluster.summary?.totalNodes ?? 0}
          </span>
          <span className="proxmox-nodes-label">nodes online</span>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="proxmox-summary">
        <div className="proxmox-summary-card vms">
          <div className="proxmox-summary-header">
            <span>Virtual Machines</span>
            <span className="proxmox-summary-total">{vms.summary?.total ?? 0}</span>
          </div>
          <div className="proxmox-summary-stats">
            <span className="running">{vms.summary?.running ?? 0} running</span>
            <span className="stopped">{vms.summary?.stopped ?? 0} stopped</span>
          </div>
        </div>
        <div className="proxmox-summary-card containers">
          <div className="proxmox-summary-header">
            <span>Containers</span>
            <span className="proxmox-summary-total">{containers.summary?.total ?? 0}</span>
          </div>
          <div className="proxmox-summary-stats">
            <span className="running">{containers.summary?.running ?? 0} running</span>
            <span className="stopped">{containers.summary?.stopped ?? 0} stopped</span>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="proxmox-filters">
        <div className="proxmox-tabs">
          <button
            className={`proxmox-tab ${expandedView === 'vms' ? 'active' : ''}`}
            onClick={() => setExpandedView('vms')}
          >
            VMs ({vms.summary?.total ?? 0})
          </button>
          <button
            className={`proxmox-tab ${expandedView === 'containers' ? 'active' : ''}`}
            onClick={() => setExpandedView('containers')}
          >
            Containers ({containers.summary?.total ?? 0})
          </button>
        </div>
        <div className="proxmox-status-filter">
          <button
            className={filter === 'all' ? 'active' : ''}
            onClick={() => setFilter('all')}
          >All</button>
          <button
            className={filter === 'running' ? 'active' : ''}
            onClick={() => setFilter('running')}
          >Running</button>
          <button
            className={filter === 'stopped' ? 'active' : ''}
            onClick={() => setFilter('stopped')}
          >Stopped</button>
        </div>
      </div>

      {/* VM/Container List */}
      <div className="proxmox-list">
        {isInitialLoad && (
          <div className="proxmox-loading">Loading cluster data...</div>
        )}

        {error && error !== 'permissionHint' && (
          <div className="proxmox-error">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            {' '}{error}
          </div>
        )}

        {error === 'permissionHint' && (
          <div className="proxmox-permission-hint">
            <div className="proxmox-permission-hint__title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffb030" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              API token lacks VM/container permissions
            </div>
            <p>Your Proxmox cluster is connected ({cluster.summary?.totalNodes} nodes visible), but the API token cannot see VMs or containers. This happens when <strong>Privilege Separation</strong> is enabled on the token.</p>
            <div className="proxmox-permission-hint__fix">
              <strong>Fix:</strong>
              <ol>
                <li>Open your Proxmox web UI</li>
                <li>Go to <strong>Datacenter → Permissions → API Tokens</strong></li>
                <li>Edit your token → <strong>uncheck "Privilege Separation"</strong></li>
                <li>Click OK, then refresh this page</li>
              </ol>
            </div>
          </div>
        )}

        {!isInitialLoad && expandedView === 'vms' && error !== 'permissionHint' && (
          filteredVMs.length === 0 ? (
            <div className="proxmox-empty">
              {filter !== 'all' ? `No ${filter} VMs` : 'No VMs found'}
            </div>
          ) : (
            filteredVMs.map(vm => (
              <div
                key={`${vm.node}-${vm.vmid}`}
                className={`proxmox-item ${vm.status}`}
                onClick={() => handleVMAction(vm)}
              >
                <span
                  className="proxmox-item-status"
                  style={{ background: getStatusColor(vm.status) }}
                />
                <div className="proxmox-item-info">
                  <span className="proxmox-item-name">{vm.name || `VM ${vm.vmid}`}</span>
                  <span className="proxmox-item-meta">
                    <span className="vmid">{vm.vmid}</span>
                    <span className="node">{vm.node}</span>
                  </span>
                </div>
                <div className="proxmox-item-resources">
                  {vm.status === 'running' && (
                    <>
                      <span className="cpu" title="CPU">
                        {vm.cpu ? `${(vm.cpu * 100).toFixed(0)}%` : '-'}
                      </span>
                      <span className="mem" title="Memory">
                        {vm.mem && vm.maxmem ? formatBytes(vm.mem) : '-'}
                      </span>
                    </>
                  )}
                  {vm.status === 'stopped' && (
                    <span className="proxmox-item-stopped">stopped</span>
                  )}
                </div>
              </div>
            ))
          )
        )}

        {!isInitialLoad && expandedView === 'containers' && error !== 'permissionHint' && (
          filteredContainers.length === 0 ? (
            <div className="proxmox-empty">
              {filter !== 'all' ? `No ${filter} containers` : 'No containers found'}
            </div>
          ) : (
            filteredContainers.map(ct => (
              <div
                key={`${ct.node}-${ct.vmid}`}
                className={`proxmox-item ${ct.status}`}
                onClick={() => handleVMAction({ ...ct, type: 'lxc' })}
              >
                <span
                  className="proxmox-item-status"
                  style={{ background: getStatusColor(ct.status) }}
                />
                <div className="proxmox-item-info">
                  <span className="proxmox-item-name">{ct.name || `CT ${ct.vmid}`}</span>
                  <span className="proxmox-item-meta">
                    <span className="vmid">{ct.vmid}</span>
                    <span className="node">{ct.node}</span>
                  </span>
                </div>
                <div className="proxmox-item-resources">
                  {ct.status === 'running' && (
                    <>
                      <span className="cpu" title="CPU">
                        {ct.cpu ? `${(ct.cpu * 100).toFixed(0)}%` : '-'}
                      </span>
                      <span className="mem" title="Memory">
                        {ct.mem && ct.maxmem ? formatBytes(ct.mem) : '-'}
                      </span>
                    </>
                  )}
                  {ct.status === 'stopped' && (
                    <span className="proxmox-item-stopped">stopped</span>
                  )}
                </div>
              </div>
            ))
          )
        )}

        {/* Stale cache indicator */}
        {cacheLoaded && !hasLiveData && !refreshing && (
          <div className="proxmox-stale-notice">
            Showing cached data from {timeAgo(scannedAt)}. Live refresh failed.
            <button onClick={() => fetchLive(false)} className="proxmox-stale-retry">Retry</button>
          </div>
        )}
      </div>
    </div>
  )
}

export default ProxmoxPanel
