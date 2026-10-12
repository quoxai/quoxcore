/**
 * useMirror Hook — Subscribe to the Mirror cognitive index
 *
 * Stream MR Phase MR-6.
 *
 * Provides live system state to any component. Refreshes every 30s.
 * All widgets get consistent data from one source instead of
 * making individual API calls.
 *
 * Usage:
 *   const { mirror, loading, age } = useMirror()
 *   const health = mirror?.core?.health
 *   const inboxCount = mirror?.inbox?.pending
 */

import { useState, useEffect, useRef } from 'react'
import { getFullIndex, getMirrorAge, refreshMirror } from '../services/mirrorIndex.js'

const REFRESH_INTERVAL = 30000 // 30 seconds

export function useMirror() {
  const [mirror, setMirror] = useState(null)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    const fetch = async () => {
      try {
        const index = await getFullIndex()
        if (mountedRef.current) {
          setMirror(index)
          setLoading(false)
        }
      } catch (err) {
        console.warn('[useMirror] Fetch failed:', err.message)
        if (mountedRef.current) setLoading(false)
      }
    }

    // Initial fetch
    fetch()

    // Refresh on interval
    const id = setInterval(fetch, REFRESH_INTERVAL)

    return () => {
      mountedRef.current = false
      clearInterval(id)
    }
  }, [])

  return {
    mirror,
    loading,
    age: getMirrorAge(),
    refresh: refreshMirror,
  }
}

/**
 * Convenience selectors for common widget needs
 */
export function useMirrorHealth() {
  const { mirror, loading } = useMirror()
  return {
    health: mirror?.core?.health ?? 0,
    status: mirror?.core?.status ?? 'unknown',
    activeServices: mirror?.core?.activeServices ?? 0,
    totalServices: mirror?.core?.totalServices ?? 0,
    loading,
  }
}

export function useMirrorImplants() {
  const { mirror, loading } = useMirror()
  return {
    implants: mirror?.implants ?? {},
    summary: mirror?.implantSummary ?? { total: 12, healthy: 0 },
    loading,
  }
}

export function useMirrorAgents() {
  const { mirror, loading } = useMirror()
  return {
    count: mirror?.agents?.count ?? 0,
    active: mirror?.agents?.active ?? 0,
    roster: mirror?.agents?.roster ?? [],
    loading,
  }
}

export function useMirrorMemory() {
  const { mirror, loading } = useMirror()
  return {
    total: mirror?.memory?.total ?? 0,
    episodic: mirror?.memory?.episodic ?? 0,
    entities: mirror?.memory?.entities ?? 0,
    learned: mirror?.memory?.learned ?? 0,
    loading,
  }
}

export default useMirror
