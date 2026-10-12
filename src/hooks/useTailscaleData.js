/**
 * useTailscaleData — React hook for Tailscale mesh data
 *
 * Fetches devices, keys, DNS, ACL, and audit log from the Tailscale connector.
 * Auto-refreshes at a configurable interval. Tracks state changes between polls.
 * Follows useWardData / useVaultCredentials patterns.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import * as ts from '../services/tailscaleClient'

const DEFAULT_POLL_INTERVAL = 30_000 // 30 seconds
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes
const KEY_EXPIRY_WARNING_DAYS = 7

export default function useTailscaleData({ autoPoll = true, pollInterval = DEFAULT_POLL_INTERVAL, orgId: providedOrgId } = {}) {
  // Use provided orgId from WorkspaceContext, fall back to localStorage
  const getOrgId = () => providedOrgId || localStorage.getItem('current_org_id') || 'default'
  // ── Data state ──
  const [devices, setDevices] = useState([])
  const [keys, setKeys] = useState([])
  const [dns, setDns] = useState(null)
  const [acl, setAcl] = useState(null)
  const [auditEntries, setAuditEntries] = useState([])
  const [summary, setSummary] = useState({ total: 0, online: 0, offline: 0, subnetRouters: 0, exitNodes: 0, expiringKeys: 0 })
  const [keySummary, setKeySummary] = useState({ total: 0, expired: 0, expiringSoon: 0 })

  // ── Status state ──
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)

  // ── Selection state ──
  const [selectedDevice, setSelectedDevice] = useState(null)

  // ── Filter state ──
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all') // 'all', 'online', 'offline', 'routes', 'expiring'

  // ── State change tracking ──
  const [stateChanges, setStateChanges] = useState({}) // { deviceId: { type: 'went_offline'|'came_online', at: Date } }
  const prevDeviceStateRef = useRef(new Map()) // deviceId -> online boolean

  // ── Refs ──
  const mountedRef = useRef(true)
  const timerRef = useRef(null)

  // ── Detect state changes between polls ──
  const detectStateChanges = useCallback((newDevices) => {
    const prev = prevDeviceStateRef.current
    const changes = {}
    const now = Date.now()

    for (const d of newDevices) {
      const wasOnline = prev.get(d.id)
      if (wasOnline !== undefined) { // Skip first poll (no previous state)
        if (wasOnline && !d.online) {
          changes[d.id] = { type: 'went_offline', at: now, hostname: d.hostname }
        } else if (!wasOnline && d.online) {
          changes[d.id] = { type: 'came_online', at: now, hostname: d.hostname }
        }
      }
    }

    // Update previous state map
    const nextMap = new Map()
    for (const d of newDevices) {
      nextMap.set(d.id, d.online)
    }
    prevDeviceStateRef.current = nextMap

    if (Object.keys(changes).length > 0) {
      setStateChanges(prev => ({ ...prev, ...changes }))
      // Clear state changes after 60 seconds
      setTimeout(() => {
        if (mountedRef.current) {
          setStateChanges(prev => {
            const next = { ...prev }
            for (const id of Object.keys(changes)) {
              delete next[id]
            }
            return next
          })
        }
      }, 60_000)
    }
  }, [])

  // ── Core fetch ──
  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const orgId = getOrgId()

      // Fetch devices and keys in parallel (the two most important)
      const [devicesResult, keysResult] = await Promise.all([
        ts.listDevices(null, orgId),
        ts.listKeys(orgId),
      ])

      if (!mountedRef.current) return

      const devList = devicesResult.devices || []
      setDevices(devList)
      setSummary(devicesResult.summary || { total: 0, online: 0, offline: 0, subnetRouters: 0, exitNodes: 0, expiringKeys: 0 })
      detectStateChanges(devList)

      const keyList = keysResult.keys || []
      setKeys(keyList)
      setKeySummary(keysResult.summary || { total: 0, expired: 0, expiringSoon: 0 })

      setLastRefresh(new Date())
    } catch (err) {
      if (mountedRef.current) setError(err.message)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [detectStateChanges])

  // ── Lazy loaders for secondary data (loaded on tab switch, not on every poll) ──
  const loadDns = useCallback(async () => {
    try {
      const result = await ts.getDns(getOrgId())
      if (mountedRef.current) setDns(result)
    } catch (err) {
      console.warn('[Tailscale] DNS fetch failed:', err.message)
    }
  }, [])

  const loadAcl = useCallback(async () => {
    try {
      const result = await ts.getAcl(getOrgId())
      if (mountedRef.current) setAcl(result)
    } catch (err) {
      console.warn('[Tailscale] ACL fetch failed:', err.message)
    }
  }, [])

  const loadAuditLog = useCallback(async (options = {}) => {
    try {
      const result = await ts.auditLog(options, getOrgId())
      if (mountedRef.current) setAuditEntries(Array.isArray(result) ? result : [])
    } catch (err) {
      console.warn('[Tailscale] Audit log fetch failed:', err.message)
    }
  }, [])

  const loadDeviceDetails = useCallback(async (deviceId) => {
    try {
      const result = await ts.deviceDetails(deviceId, getOrgId())
      if (mountedRef.current) setSelectedDevice(result)
      return result
    } catch (err) {
      console.warn('[Tailscale] Device details failed:', err.message)
      return null
    }
  }, [])

  // ── Write actions ──
  const authorizeDevice = useCallback(async (deviceId, authorized) => {
    const result = await ts.authorizeDevice(deviceId, authorized, getOrgId())
    await refresh() // Refresh devices after action
    return result
  }, [refresh])

  const setDeviceTags = useCallback(async (deviceId, tags) => {
    const result = await ts.setDeviceTags(deviceId, tags, getOrgId())
    await refresh()
    return result
  }, [refresh])

  const manageRoutes = useCallback(async (deviceId, routes) => {
    const result = await ts.manageRoutes(deviceId, routes, getOrgId())
    await refresh()
    return result
  }, [refresh])

  const createAuthKey = useCallback(async (options) => {
    const result = await ts.createAuthKey(options, getOrgId())
    // Refresh keys after creation
    const keysResult = await ts.listKeys(getOrgId())
    if (mountedRef.current) {
      setKeys(keysResult.keys || [])
      setKeySummary(keysResult.summary || { total: 0, expired: 0, expiringSoon: 0 })
    }
    return result
  }, [])

  const revokeKey = useCallback(async (keyId) => {
    const result = await ts.revokeKey(keyId, getOrgId())
    const keysResult = await ts.listKeys(getOrgId())
    if (mountedRef.current) {
      setKeys(keysResult.keys || [])
      setKeySummary(keysResult.summary || { total: 0, expired: 0, expiringSoon: 0 })
    }
    return result
  }, [])

  // ── Filtered devices (client-side) ──
  const filteredDevices = useMemo(() => {
    let result = devices

    // Status filter
    if (statusFilter === 'online') result = result.filter(d => d.online)
    else if (statusFilter === 'offline') result = result.filter(d => !d.online)
    else if (statusFilter === 'routes') result = result.filter(d => d.isSubnetRouter || d.isExitNode)
    else if (statusFilter === 'expiring') result = result.filter(d => d.daysUntilExpiry !== null && d.daysUntilExpiry <= KEY_EXPIRY_WARNING_DAYS)

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase().trim()
      result = result.filter(d =>
        (d.hostname || '').toLowerCase().includes(q) ||
        (d.fqdn || '').toLowerCase().includes(q) ||
        (d.ips || []).some(ip => ip.includes(q)) ||
        (d.tags || []).some(t => t.toLowerCase().includes(q)) ||
        (d.os || '').toLowerCase().includes(q)
      )
    }

    return result
  }, [devices, statusFilter, search])

  // ── Auto-poll lifecycle ──
  useEffect(() => {
    mountedRef.current = true
    refresh()

    if (autoPoll && pollInterval > 0) {
      timerRef.current = setInterval(refresh, pollInterval)
    }

    return () => {
      mountedRef.current = false
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, []) // Only on mount — refresh is stable via useCallback

  // ── Auto-retry when user returns to page (e.g. after adding credentials in vault) ──
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && error) {
        refresh()
      }
    }
    const handleFocus = () => {
      if (error) refresh()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleFocus)
    // Also listen for route changes back to this page
    window.addEventListener('popstate', handleFocus)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('popstate', handleFocus)
    }
  }, [error, refresh])

  // ── Org switch listener ──
  // Why clear data eagerly: without this, the previous org's devices/keys
  // remain visible (and the prior error stays on screen) until the new
  // refresh resolves — which masks org-context as "stale data". Clear first,
  // then refresh, so the UI snaps to a known-empty state immediately.
  useEffect(() => {
    const handler = () => {
      prevDeviceStateRef.current = new Map()
      setStateChanges({})
      setDevices([])
      setKeys([])
      setDns(null)
      setAcl(null)
      setAuditEntries([])
      setSummary({ total: 0, online: 0, offline: 0, subnetRouters: 0, exitNodes: 0, expiringKeys: 0 })
      setKeySummary({ total: 0, expired: 0, expiringSoon: 0 })
      setSelectedDevice(null)
      setError(null)
      setLoading(true)
      refresh()
    }
    window.addEventListener('quox-org-switch', handler)
    return () => window.removeEventListener('quox-org-switch', handler)
  }, [refresh])

  return {
    // ── Data ──
    devices,
    filteredDevices,
    keys,
    dns,
    acl,
    auditEntries,
    summary,
    keySummary,

    // ── Selection ──
    selectedDevice,
    setSelectedDevice,

    // ── Status ──
    loading,
    error,
    lastRefresh,
    stateChanges,

    // ── Filters ──
    search,
    setSearch,
    statusFilter,
    setStatusFilter,

    // ── Lazy loaders ──
    loadDns,
    loadAcl,
    loadAuditLog,
    loadDeviceDetails,

    // ── Write actions ──
    authorizeDevice,
    setDeviceTags,
    manageRoutes,
    createAuthKey,
    revokeKey,

    // ── Core ──
    refresh,
  }
}
