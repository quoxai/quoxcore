/**
 * useCognitiveData Hook
 *
 * Fetches and manages real-time data for all cognitive implants.
 * Uses caching for instant initial display, then refreshes in background.
 * Refreshes every 30 seconds and provides loading/error states.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  getCachedData,
  hasCachedData,
  refreshCache,
  subscribeToCacheUpdates,
} from '../../../services/cognitiveDataCache'
import { getLockedImplants } from '../../../services/cognitiveTopologyService'

const REFRESH_INTERVAL = 30000 // 30 seconds

export function useCognitiveData() {
  // Initialize from cache if available for instant display
  const cached = getCachedData()
  const [data, setData] = useState(cached.data || {})
  const [loading, setLoading] = useState(!hasCachedData())
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(cached.timestamp)
  const [lockedImplants, setLockedImplants] = useState(cached.lockedImplants || [])

  const mountedRef = useRef(true)

  const fetchData = useCallback(async (isInitial = false) => {
    try {
      // If we have cached data on initial load, show it immediately
      // and only set loading if no cached data exists
      if (isInitial && hasCachedData()) {
        const cached = getCachedData()
        setData(cached.data || {})
        setLockedImplants(cached.lockedImplants || [])
        setLastUpdated(cached.timestamp)

        // If data is fresh, don't show loading
        if (cached.isFresh) {
          setLoading(false)
          return
        }
      }

      // Refresh cache
      const result = await refreshCache()

      if (!mountedRef.current) return

      if (result.data) {
        setData(result.data)
        setLockedImplants(result.lockedImplants || [])
        setLastUpdated(result.timestamp)
        setError(result.error || null)
      } else if (result.error) {
        setError(result.error)
      }
    } catch (err) {
      if (mountedRef.current) {
        console.error('Failed to fetch cognitive data:', err)
        setError(err.message || 'Failed to fetch data')
        // Still update locked implants even on error
        try {
          setLockedImplants(getLockedImplants())
        } catch {}
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true

    // Initial fetch
    fetchData(true)

    // Subscribe to cache updates (for when other components refresh)
    const unsubscribe = subscribeToCacheUpdates((cached) => {
      if (mountedRef.current && cached.data) {
        setData(cached.data)
        setLockedImplants(cached.lockedImplants || [])
        setLastUpdated(cached.timestamp)
      }
    })

    // Set up refresh interval
    const interval = setInterval(() => {
      fetchData(false)
    }, REFRESH_INTERVAL)

    return () => {
      mountedRef.current = false
      unsubscribe()
      clearInterval(interval)
    }
  }, [fetchData])

  const refresh = useCallback(() => {
    setLoading(true)
    fetchData(false)
  }, [fetchData])

  return {
    data,
    loading,
    error,
    lastUpdated,
    lockedImplants,
    refresh,
    isLocked: (implantId) => lockedImplants.includes(implantId),
  }
}

export default useCognitiveData
