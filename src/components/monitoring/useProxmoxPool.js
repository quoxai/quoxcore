/**
 * useProxmoxPool: read the org's HYPERION VM pool (GET /api/v1/proxmox/pool) through the
 * authenticated collector fetch, refresh on an interval, and expose reload(). The server is
 * the source of truth; nothing here is persisted client-side.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../../contexts/AuthContext'

export const POOL_URL = '/collector/api/v1/proxmox/pool'

/** Server error body -> the exact text to show. */
export function poolErrorText(body, status) {
  if (body && typeof body === 'object') {
    if (body.message) return String(body.message)
    if (body.error) return String(body.error)
  }
  return `Request failed (HTTP ${status})`
}

export function usePoolStatus({ enabled = true, intervalMs = 30000 } = {}) {
  const { authFetch } = useAuth()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(enabled)
  const alive = useRef(true)

  const reload = useCallback(async () => {
    try {
      const res = await authFetch(POOL_URL)
      let body = null
      try { body = await res.json() } catch { body = null }
      if (!alive.current) return null
      if (!res.ok) {
        setError(poolErrorText(body, res.status))
        setLoading(false)
        return null
      }
      setData(body)
      setError(null)
      setLoading(false)
      return body
    } catch (e) {
      if (alive.current) { setError(e && e.message ? e.message : 'Could not reach the collector'); setLoading(false) }
      return null
    }
  }, [authFetch])

  useEffect(() => {
    alive.current = true
    if (!enabled) return () => { alive.current = false }
    reload()
    const id = setInterval(reload, intervalMs)
    return () => { alive.current = false; clearInterval(id) }
  }, [enabled, intervalMs, reload])

  return { data, error, loading, reload }
}

/** One short object for the HYPERION chat sidebar. */
export function poolSummary(data) {
  if (!data || !data.config) return null
  const counts = data.counts || {}
  return {
    enabled: !!data.config.enabled,
    lanes: (data.config.lanes || []).length,
    warm_target: data.config.warm_target ?? 0,
    ready: counts.ready || 0,
    leased: counts.leased || 0,
    building: counts.building || 0,
    failed: counts.failed || 0,
    paused: !!data.paused,
  }
}
