/**
 * useAnalytics Hook — Phase D5
 *
 * Fetches server-side delivery analytics with configurable time range.
 * Follows useRoutingRules.js pattern (mountedRef, authFetch, useCallback).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useWorkspace } from '../contexts/WorkspaceContext'
import { useAuth } from '../contexts/AuthContext'

export function useAnalytics(initialDays = 7) {
  const { currentOrg } = useWorkspace()
  const { authFetch } = useAuth()
  const orgId = currentOrg?.id
  const mountedRef = useRef(true)

  const [analytics, setAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [days, setDays] = useState(initialDays)

  const fetchAnalytics = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/delivery-analytics?days=${days}`)
      if (!resp.ok) throw new Error('Failed to fetch analytics')
      const data = await resp.json()
      if (mountedRef.current) {
        setAnalytics(data)
        setError(null)
      }
    } catch (err) {
      if (mountedRef.current) setError(err.message)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [orgId, days, authFetch])

  useEffect(() => {
    mountedRef.current = true
    fetchAnalytics()
    return () => { mountedRef.current = false }
  }, [fetchAnalytics])

  return { analytics, loading, error, days, setDays, refresh: fetchAnalytics }
}
