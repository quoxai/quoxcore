/**
 * useCognitiveSummary — shared 30s poll for the "Shape of Quox" HUD.
 *
 * Wraps cognitiveTopologyService's getCoreHealth() / fetchAllImplantData() /
 * getLockedImplants() / getMemoryLatticeStats() behind ONE interval so
 * multiple HUD consumers don't each open their own poll loop. Mirrors the
 * lifecycle pattern used by CognitiveSummaryCard.jsx (dashboard card) and
 * useCognitiveData.js (topology view).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  getCoreHealth,
  fetchAllImplantData,
  getLockedImplants,
  getMemoryLatticeStats,
} from '../services/cognitiveTopologyService'

const POLL_INTERVAL = 30000 // 30 seconds — matches HealthContext / CognitiveSummaryCard cadence

/**
 * Mirrors the exact "is this faculty reporting" predicate used by
 * CognitiveSummaryCard.jsx: a faculty counts as reporting when it has a
 * real health score and isn't a localStorage/offline fallback or carrying
 * a failureReason.
 */
export function isImplantReporting(implantData) {
  return Boolean(
    implantData &&
    implantData.healthScore !== null &&
    implantData.healthScore !== undefined &&
    !implantData.fallback &&
    !implantData.failureReason
  )
}

export function useCognitiveSummary() {
  const [core, setCore] = useState(null)
  const [implants, setImplants] = useState(null)
  const [locked, setLocked] = useState([])
  const [memory, setMemory] = useState(null)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  const load = useCallback(async () => {
    try {
      const [coreHealth, implantData, memoryStats] = await Promise.all([
        getCoreHealth(),
        fetchAllImplantData(),
        getMemoryLatticeStats(),
      ])
      if (!mountedRef.current) return
      setCore(coreHealth)
      setImplants(implantData)
      setMemory(memoryStats)
      // getLockedImplants() is synchronous (tier check only) — no fetch involved.
      setLocked(getLockedImplants())
    } catch (err) {
      console.error('[useCognitiveSummary] load failed:', err)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    load()
    const interval = setInterval(load, POLL_INTERVAL)
    return () => {
      mountedRef.current = false
      clearInterval(interval)
    }
  }, [load])

  return { core, implants, locked, memory, loading }
}

export default useCognitiveSummary
