/**
 * HealthContext — Shared health check state
 *
 * Centralises service health polling so multiple consumers (AppShell header,
 * DashboardView, SystemHealthBadge) can read the same data without duplicating
 * the 30-second health check cycle.
 */

import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { runFullHealthCheck } from '../services/healthCheck'
import { isDevBypassEnabled } from '../utils/devMode'
import { useAuth } from './AuthContext'

const HealthContext = createContext(null)

// Poll every 30 seconds
const POLL_INTERVAL = 30000

export function HealthProvider({ children }) {
  // CLARITY-1: HealthProvider mounts above the router (wraps /login too), so
  // without this gate the 30s service sweep — including auth-gated quoxflow
  // + quoxagent endpoint probes — runs unconditionally on the unauthenticated
  // login page, spamming the console/network panel with 401s. HealthProvider
  // is nested inside AuthProvider in App.jsx, so useAuth() is available here.
  const { isAuthenticated } = useAuth()
  const [healthData, setHealthData] = useState(null)
  const [loading, setLoading] = useState(true)
  const intervalRef = useRef(null)
  const prevDownRef = useRef(new Set())  // Track consecutive failures for debounce

  const fetchHealth = useCallback(async () => {
    if (isDevBypassEnabled()) {
      setHealthData({
        services: {},
        summary: { total: 0, healthy: 0, degraded: 0, down: 0, criticalDown: 0 },
        timestamp: new Date().toISOString(),
      })
      return
    }
    try {
      const result = await runFullHealthCheck({ authenticated: isAuthenticated })
      // Debounce: only mark a service as down if it was ALSO down on the previous check
      // This prevents transient network glitches from showing "9 services down"
      if (result?.services) {
        // A service is "bad" if it is not responding OR responding but not
        // healthy (degraded). Both need 2 consecutive bad sweeps to count.
        const currentDown = new Set()
        for (const [key, svc] of Object.entries(result.services)) {
          if (!svc.responding || !svc.healthy) currentDown.add(key)
        }
        // Debounce a first failure so a transient blip does not raise an
        // alarm, WITHOUT claiming the service answered. This used to set
        // responding = true and healthy = true on a service that had just
        // failed, so the data itself said the opposite of what happened and
        // every consumer inherited the falsehood. Flagging it lets a consumer
        // choose not to alarm yet while the record stays true.
        for (const [key, svc] of Object.entries(result.services)) {
          if ((!svc.responding || !svc.healthy) && !prevDownRef.current.has(key)) {
            svc._awaitingConfirmation = true
          }
        }
        prevDownRef.current = currentDown
      }
      setHealthData(result)
    } catch (err) {
      console.error('[HealthContext] Health check failed:', err)
    } finally {
      setLoading(false)
    }
  }, [isAuthenticated])

  // CLARITY-1: gate the sweep on auth + tab visibility.
  // - Unauthenticated: no sweep at all (clears any existing interval, resolves
  //   the loading flag so consumers don't spin forever waiting on data that
  //   will never arrive pre-login).
  // - Authenticated + tab hidden: pause the interval entirely (no point
  //   polling a backgrounded tab).
  // - Authenticated + tab becomes visible again: fire an immediate sweep and
  //   resume the interval.
  useEffect(() => {
    const clearPoll = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    if (!isAuthenticated) {
      clearPoll()
      setLoading(false)
      return clearPoll
    }

    const startPoll = () => {
      clearPoll()
      intervalRef.current = setInterval(() => {
        if (document.hidden) return
        fetchHealth()
      }, POLL_INTERVAL)
    }

    fetchHealth()
    startPoll()

    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearPoll()
      } else {
        fetchHealth()
        startPoll()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      clearPoll()
    }
  }, [fetchHealth, isAuthenticated])

  // Compute overall status from health data
  const summary = healthData?.summary || {}
  const services = healthData?.services || {}

  // 'unknown' until a check actually answers. This defaulted to 'operational',
  // so a health system that had never successfully run, or whose fetch threw,
  // reported the platform as fine. An absent answer is not a good answer.
  let overallStatus = healthData ? 'operational' : 'unknown'
  let degradedCount = 0
  let downCount = 0

  // Clone services so we can patch without mutating health data
  let displayServices = services

  if (healthData) {
    for (const svc of Object.values(services)) {
      // A first, unconfirmed failure is not counted yet (the debounce), but it
      // is still recorded as not responding. Counting and truth-telling are
      // different jobs and only one of them should be softened.
      if (!svc.responding) {
        if (!svc._awaitingConfirmation) downCount++
      } else if (!svc.healthy) {
        if (!svc._awaitingConfirmation) degradedCount++
      }
    }
    // Three or more services down at once is usually the caller's own
    // connection, not three simultaneous failures. That inference is
    // reasonable. What it must NOT do is resolve to "everything is fine".
    //
    // This used to set overallStatus = 'operational', zero downCount, and
    // rewrite every service to { responding: true, healthy: true }. So the
    // worse the outage, the more confidently the dashboard claimed health: a
    // total platform failure and a healthy platform rendered identically, and
    // DEFCON (which reads downCount) stayed GREEN through both. On 2026-08-19
    // this install had its disk fill and services genuinely fall over, which
    // is exactly the case the heuristic erases.
    //
    // Fabricating `responding: true` for something that did not respond is the
    // part that makes it a lie rather than a filter. "I cannot reach the
    // platform" and "the platform is fine" are different statements and only
    // one of them is supportable from a failed fetch.
    if (downCount >= 3) {
      overallStatus = 'unreachable'
      // downCount is preserved: consumers that count failures should still see
      // them. What changes is how it is DESCRIBED, not whether it happened.
      displayServices = {}
      for (const [key, svc] of Object.entries(services)) {
        displayServices[key] = { ...svc, _unknown: true }
      }
    } else if (downCount > 0) {
      overallStatus = 'major_outage'
    } else if (degradedCount > 0) {
      overallStatus = 'degraded'
    }
  }

  const value = {
    healthData,
    loading,
    services: displayServices,
    summary,
    overallStatus,
    degradedCount,
    downCount,
    lastCheck: healthData?.timestamp || null,
    refetch: fetchHealth
  }

  return (
    <HealthContext.Provider value={value}>
      {children}
    </HealthContext.Provider>
  )
}

export function useHealth() {
  const ctx = useContext(HealthContext)
  if (!ctx) {
    // Graceful fallback when used outside provider
    return {
      healthData: null,
      loading: true,
      services: {},
      summary: {},
      overallStatus: 'operational',
      degradedCount: 0,
      downCount: 0,
      lastCheck: null,
      refetch: () => {}
    }
  }
  return ctx
}

export default HealthContext
