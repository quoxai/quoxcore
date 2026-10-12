/**
 * Cognitive Data Cache Service
 *
 * Provides data caching and preloading for the Cognitive Topology.
 * Data persists across navigation and refreshes in the background.
 *
 * Benefits:
 * - Instant display of cached data on navigation
 * - Background refresh keeps data fresh
 * - Graceful degradation if services are slow/down
 */

import { fetchAllImplantData, getLockedImplants } from './cognitiveTopologyService'

// Cache storage
let cachedData = null
let cachedLockedImplants = []
let cacheTimestamp = null
let isRefreshing = false
let refreshPromise = null

// Cache settings
const CACHE_TTL = 60000 // 1 minute - consider cached data fresh
const STALE_TTL = 300000 // 5 minutes - show stale data while refreshing
const FETCH_TIMEOUT = 10000 // 10 second timeout

/**
 * Get cached data if available
 */
export function getCachedData() {
  return {
    data: cachedData,
    lockedImplants: cachedLockedImplants,
    timestamp: cacheTimestamp,
    isFresh: cacheTimestamp && (Date.now() - cacheTimestamp.getTime()) < CACHE_TTL,
    isStale: cacheTimestamp && (Date.now() - cacheTimestamp.getTime()) > STALE_TTL,
  }
}

/**
 * Check if cache has usable data
 */
export function hasCachedData() {
  return cachedData !== null && cacheTimestamp !== null
}

/**
 * Fetch fresh data with timeout protection
 */
async function fetchWithTimeout() {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Data fetch timeout')), FETCH_TIMEOUT)
  )

  const implantData = await Promise.race([
    fetchAllImplantData(),
    timeoutPromise
  ])

  return implantData
}

/**
 * Refresh the cache
 * Returns existing promise if refresh is already in progress
 */
export async function refreshCache() {
  // If already refreshing, return the existing promise
  if (isRefreshing && refreshPromise) {
    return refreshPromise
  }

  isRefreshing = true

  refreshPromise = (async () => {
    try {
      const implantData = await fetchWithTimeout()
      const locked = getLockedImplants()

      // Update cache
      cachedData = implantData
      cachedLockedImplants = locked
      cacheTimestamp = new Date()

      return {
        data: cachedData,
        lockedImplants: cachedLockedImplants,
        timestamp: cacheTimestamp,
        error: null,
      }
    } catch (err) {
      console.warn('Cache refresh failed:', err.message)

      // Still update locked implants even on error
      try {
        cachedLockedImplants = getLockedImplants()
      } catch {}

      return {
        data: cachedData,
        lockedImplants: cachedLockedImplants,
        timestamp: cacheTimestamp,
        error: err.message,
      }
    } finally {
      isRefreshing = false
      refreshPromise = null
    }
  })()

  return refreshPromise
}

/**
 * Preload data in the background
 * Call this early (e.g., on app init or route prefetch)
 */
export function preloadCognitiveData() {
  // Only preload if we don't have fresh data
  const { isFresh } = getCachedData()
  if (!isFresh && !isRefreshing) {
    refreshCache().catch(() => {
      // Silently fail - preload is best-effort
    })
  }
}

/**
 * Get data - returns cached if fresh, otherwise triggers refresh
 * Always returns immediately with whatever data is available
 */
export async function getCognitiveData(options = {}) {
  const { forceRefresh = false, waitForFresh = false } = options
  const cached = getCachedData()

  // If we have fresh data and don't need to force refresh, return it
  if (cached.isFresh && !forceRefresh) {
    return {
      data: cached.data,
      lockedImplants: cached.lockedImplants,
      timestamp: cached.timestamp,
      fromCache: true,
      error: null,
    }
  }

  // If we have stale data and don't need to wait, return stale + trigger background refresh
  if (cached.data && !waitForFresh && !forceRefresh) {
    // Trigger background refresh
    refreshCache()

    return {
      data: cached.data,
      lockedImplants: cached.lockedImplants,
      timestamp: cached.timestamp,
      fromCache: true,
      isStale: true,
      error: null,
    }
  }

  // Need to wait for fresh data
  const result = await refreshCache()

  return {
    ...result,
    fromCache: false,
    isStale: false,
  }
}

/**
 * Subscribe to cache updates
 * Returns unsubscribe function
 */
const subscribers = new Set()

export function subscribeToCacheUpdates(callback) {
  subscribers.add(callback)
  return () => subscribers.delete(callback)
}

function notifySubscribers() {
  const cached = getCachedData()
  subscribers.forEach(cb => cb(cached))
}

// Notify subscribers when cache updates
const originalRefreshCache = refreshCache
refreshCache = async function() {
  const result = await originalRefreshCache()
  notifySubscribers()
  return result
}

/**
 * Clear the cache (useful for testing or forced refresh)
 */
export function clearCache() {
  cachedData = null
  cachedLockedImplants = []
  cacheTimestamp = null
  notifySubscribers()
}

/**
 * Start background auto-refresh
 * Returns cleanup function
 */
export function startAutoRefresh(intervalMs = 30000) {
  const interval = setInterval(() => {
    refreshCache()
  }, intervalMs)

  return () => clearInterval(interval)
}

export default {
  getCachedData,
  hasCachedData,
  refreshCache,
  preloadCognitiveData,
  getCognitiveData,
  subscribeToCacheUpdates,
  clearCache,
  startAutoRefresh,
}
