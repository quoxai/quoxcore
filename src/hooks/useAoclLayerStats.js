/**
 * useAoclLayerStats — AOCL layer stats for the "Shape of Quox" HUD.
 *
 * Wraps aoclAnalytics.getLayerStats() (confirmed present, see
 * src/services/aoclAnalytics.js) with a 60s refresh over the last day of
 * AEE envelope data. If getLayerStats is ever removed, this degrades to a
 * static stub rather than inventing a replacement API.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { getLayerStats, TIME_RANGES } from '../services/aoclAnalytics'

const REFRESH_INTERVAL = 60000 // 60 seconds

export function useAoclLayerStats() {
  const [layers, setLayers] = useState([])
  const [loading, setLoading] = useState(typeof getLayerStats === 'function')
  const mountedRef = useRef(true)

  const load = useCallback(async () => {
    try {
      const stats = await getLayerStats({ timeRange: TIME_RANGES.DAY })
      if (!mountedRef.current) return
      setLayers(stats?.layers || [])
    } catch (err) {
      console.error('[useAoclLayerStats] load failed:', err)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (typeof getLayerStats !== 'function') return undefined

    mountedRef.current = true
    load()
    const interval = setInterval(load, REFRESH_INTERVAL)
    return () => {
      mountedRef.current = false
      clearInterval(interval)
    }
  }, [load])

  return { layers, available: typeof getLayerStats === 'function', loading }
}

export default useAoclLayerStats
