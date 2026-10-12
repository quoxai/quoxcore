/**
 * useRoutingRules Hook
 *
 * CRUD + optimistic updates for routing rules.
 * Follows useIntegrations.js pattern.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useWorkspace } from '../contexts/WorkspaceContext'
import { useAuth } from '../contexts/AuthContext'

export function useRoutingRules() {
  const { currentOrg } = useWorkspace()
  const { authFetch } = useAuth()
  const orgId = currentOrg?.id
  const mountedRef = useRef(true)

  const [rules, setRules] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchRules = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/routing-rules?limit=100`)
      if (!resp.ok) throw new Error('Failed to fetch rules')
      const data = await resp.json()
      if (mountedRef.current) {
        setRules(data.data || data.items || [])
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
    fetchRules()
    return () => { mountedRef.current = false }
  }, [fetchRules])

  const createRule = useCallback(async (rule) => {
    if (!orgId) return null
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/routing-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rule)
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to create rule')
      }
      const created = await resp.json()
      setRules(prev => [...prev, created].sort((a, b) => a.priority - b.priority))
      return created
    } catch (err) {
      setError(err.message)
      return null
    }
  }, [orgId, authFetch])

  const updateRule = useCallback(async (ruleId, updates) => {
    if (!orgId) return false
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/routing-rules/${ruleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to update rule')
      }
      const updated = await resp.json()
      setRules(prev => prev.map(r => r.id === ruleId ? { ...r, ...updated } : r)
        .sort((a, b) => a.priority - b.priority))
      return true
    } catch (err) {
      setError(err.message)
      return false
    }
  }, [orgId, authFetch])

  const deleteRule = useCallback(async (ruleId) => {
    if (!orgId) return false
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/routing-rules/${ruleId}`, {
        method: 'DELETE'
      })
      if (!resp.ok) throw new Error('Failed to delete rule')
      setRules(prev => prev.filter(r => r.id !== ruleId))
      return true
    } catch (err) {
      setError(err.message)
      return false
    }
  }, [orgId, authFetch])

  const toggleEnabled = useCallback(async (ruleId, enabled) => {
    // Optimistic update
    setRules(prev => prev.map(r => r.id === ruleId ? { ...r, enabled: enabled ? 1 : 0 } : r))
    const ok = await updateRule(ruleId, { enabled })
    if (!ok) {
      // Revert
      setRules(prev => prev.map(r => r.id === ruleId ? { ...r, enabled: enabled ? 0 : 1 } : r))
    }
    return ok
  }, [updateRule])

  return {
    rules,
    loading,
    error,
    createRule,
    updateRule,
    deleteRule,
    toggleEnabled,
    refresh: fetchRules
  }
}
