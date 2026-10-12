/**
 * useScopeAssignments Hook — Phase D5
 *
 * Fetches scope-channel assignments and provides toggle functionality.
 * Follows useRoutingRules.js pattern (mountedRef, authFetch, useCallback).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useWorkspace } from '../contexts/WorkspaceContext'
import { useAuth } from '../contexts/AuthContext'

export function useScopeAssignments() {
  const { currentOrg } = useWorkspace()
  const { authFetch } = useAuth()
  const orgId = currentOrg?.id
  const mountedRef = useRef(true)

  const [assignments, setAssignments] = useState({}) // { [scopeId]: { [channelType]: boolean } }
  const [scopes, setScopes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const fetchData = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    try {
      // Fetch assignments and scopes in parallel
      const [assignResp, scopeResp] = await Promise.all([
        authFetch(`/api/orgs/${orgId}/scope-channel-assignments`),
        authFetch(`/api/orgs/${orgId}/scopes?limit=200`)
      ])

      if (!assignResp.ok) throw new Error('Failed to fetch assignments')
      if (!scopeResp.ok) throw new Error('Failed to fetch scopes')

      const assignData = await assignResp.json()
      const scopeData = await scopeResp.json()

      if (mountedRef.current) {
        // Transform assignments into map
        const map = {}
        for (const a of (assignData.data || [])) {
          if (!map[a.scope_id]) map[a.scope_id] = {}
          map[a.scope_id][a.channel_type] = !!a.enabled
        }
        setAssignments(map)
        setScopes(scopeData.data || scopeData.items || [])
        setError(null)
      }
    } catch (err) {
      if (mountedRef.current) setError(err.message)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [orgId, authFetch])

  useEffect(() => {
    mountedRef.current = true
    fetchData()
    return () => { mountedRef.current = false }
  }, [fetchData])

  const toggleAssignment = useCallback(async (scopeId, channelType, enabled) => {
    if (!orgId) return false
    // Optimistic update
    setAssignments(prev => ({
      ...prev,
      [scopeId]: { ...(prev[scopeId] || {}), [channelType]: enabled }
    }))
    setSaving(true)
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/scope-channel-assignments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope_id: scopeId, channel_type: channelType, enabled })
      })
      if (!resp.ok) throw new Error('Failed to toggle')
      setSaving(false)
      return true
    } catch (err) {
      // Revert on failure
      setAssignments(prev => ({
        ...prev,
        [scopeId]: { ...(prev[scopeId] || {}), [channelType]: !enabled }
      }))
      setError(err.message)
      setSaving(false)
      return false
    }
  }, [orgId, authFetch])

  return { assignments, scopes, loading, error, saving, toggleAssignment, refresh: fetchData }
}
