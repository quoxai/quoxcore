/**
 * useProxmoxData — Shared hook for Proxmox cluster state.
 *
 * Extracts fetch/cache logic from ProxmoxPanel so multiple components
 * (ProxmoxPanel compact mode, ProxmoxTable, ProxmoxView) can share the
 * same live data without duplicate requests.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { getVMs, getContainers, getClusterStatus, getVMIPs, formatBytes, formatUptime } from '../../../services/proxmoxClient'

const CACHE_URL = '/collector/api/v1/monitoring/cache/proxmox'
const REFRESH_INTERVAL = 30000 // 30s for sparkline sampling
const IP_REFRESH_INTERVAL = 300000 // 5 min for IP resolution

/**
 * Format a relative time string from an ISO date
 */
export function timeAgo(isoDate) {
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

export function getStatusColor(status) {
  switch (status) {
    case 'running': return '#30ff90'
    case 'stopped': return '#ff6b30'
    case 'paused': return '#ffb030'
    default: return '#666'
  }
}

/**
 * Does this error mean "no Proxmox credential/URL configured" (as opposed to a
 * real failure of a configured connection)? The collector proxy answers 404
 * "Unknown service" / not_configured when nothing is set up.
 */
export function isNotConfiguredError(error) {
  if (!error || typeof error !== 'string') return false
  return /not[_ ]configured|unknown service|no proxmox (credential|url)/i.test(error)
}

/**
 * Decide what the Proxmox surface may show, from the LIVE read outcome.
 * An error is never data: a failed read must not render as "0 nodes / 0 VMs".
 *
 *   loading        first read in flight, nothing cached
 *   not_configured live read says no credential -> onboarding
 *   error          live read failed (auth/TLS/network), nothing cached
 *   stale          live read failed but a cached snapshot exists -> show it, labelled
 *   ok             live read succeeded
 */
export function deriveConnection({ liveStatus, error, cacheLoaded, scannedAt, cachedNodes = 0 }) {
  if (liveStatus === 'ok') return { state: 'ok', message: null }
  if (liveStatus === 'failed') {
    if (isNotConfiguredError(error)) return { state: 'not_configured', message: error }
    if (cacheLoaded && cachedNodes > 0) {
      return { state: 'stale', message: error, cachedAt: scannedAt }
    }
    return { state: 'error', message: error || 'Failed to connect to Proxmox API' }
  }
  // pending
  if (cacheLoaded && cachedNodes > 0) return { state: 'ok', message: null }
  return { state: 'loading', message: null }
}

export function useProxmoxData({ autoRefresh = true } = {}) {
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [scannedAt, setScannedAt] = useState(null)
  const [hasLiveData, setHasLiveData] = useState(false)
  // 'pending' until the first live read settles; then 'ok' | 'failed'
  const [liveStatus, setLiveStatus] = useState('pending')
  const [cacheLoaded, setCacheLoaded] = useState(false)

  const [cluster, setCluster] = useState({ summary: { totalNodes: 0, online: 0, quorate: false } })
  const [vms, setVMs] = useState({ vms: [], summary: { total: 0, running: 0, stopped: 0 } })
  const [containers, setContainers] = useState({ containers: [], summary: { total: 0, running: 0, stopped: 0 } })

  const [selectedVM, setSelectedVM] = useState(null)
  const [ipMap, setIpMap] = useState(new Map())
  const ipLastFetchRef = useRef(0)

  const mountedRef = useRef(true)

  const applyData = useCallback((clusterData, vmData, ctData) => {
    setCluster(clusterData)
    setVMs(vmData)
    setContainers(ctData)
  }, [])

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

      // A failed live read is an outcome, not data: keep the last good
      // (cached) snapshot, never overwrite it with the zero-count error shape.
      let failure = null
      if (!clusterData.success) {
        failure = clusterData.error || 'Failed to connect to Proxmox API'
      } else if (!vmData.success) {
        failure = vmData.error || 'Failed to load VM data'
      }

      if (failure) {
        setError(failure)
        setLiveStatus('failed')
        return
      }

      if (clusterData.summary?.totalNodes > 0 && vmData.summary?.total === 0 && ctData.summary?.total === 0) {
        setError('permissionHint')
      }

      applyData(clusterData, vmData, ctData)
      setScannedAt(new Date().toISOString())
      setHasLiveData(true)
      setLiveStatus('ok')

      saveToCache(clusterData, vmData, ctData)

      // IP enrichment (throttled to every 5 min)
      const now = Date.now()
      if (now - ipLastFetchRef.current > IP_REFRESH_INTERVAL) {
        ipLastFetchRef.current = now
        const combined = [
          ...(vmData.vms || []).map(v => ({ ...v, type: 'qemu' })),
          ...(ctData.containers || []).map(c => ({ ...c, type: 'lxc' })),
        ]
        getVMIPs(combined).then(newIpMap => {
          if (mountedRef.current && newIpMap.size > 0) setIpMap(newIpMap)
        }).catch(() => {})
      }
    } catch (err) {
      if (mountedRef.current) { setError(err.message); setLiveStatus('failed') }
    } finally {
      if (mountedRef.current) setRefreshing(false)
    }
  }, [applyData, saveToCache])

  useEffect(() => {
    mountedRef.current = true
    let interval

    ;(async () => {
      const hadCache = await loadCache()
      await fetchLive(hadCache)
      if (autoRefresh) {
        interval = setInterval(() => fetchLive(true), REFRESH_INTERVAL)
      }
    })()

    return () => {
      mountedRef.current = false
      if (interval) clearInterval(interval)
    }
  }, [loadCache, fetchLive, autoRefresh])

  // Combined items list for the table (VMs + containers with type tag + IPs)
  const allItems = [
    ...(vms.vms || []).map(vm => ({ ...vm, type: 'qemu' })),
    ...(containers.containers || []).map(ct => ({ ...ct, type: 'lxc' }))
  ].map(item => {
    const key = `${item.node}-${item.vmid}`
    const ip = ipMap.get(key)
    return ip ? { ...item, ip } : item
  })

  const connection = deriveConnection({
    liveStatus, error, cacheLoaded, scannedAt,
    cachedNodes: cluster?.summary?.totalNodes ?? 0,
  })

  return {
    // Data
    cluster,
    vms,
    containers,
    allItems,

    // State
    refreshing,
    error,
    scannedAt,
    hasLiveData,
    cacheLoaded,
    liveStatus,
    connection,
    isInitialLoad: !cacheLoaded && !hasLiveData && refreshing,

    // Selection
    selectedVM,
    setSelectedVM,

    // Actions
    fetchLive,

    // Utilities (re-export for convenience)
    formatBytes,
    formatUptime,
    timeAgo,
    getStatusColor,
  }
}

export default useProxmoxData
