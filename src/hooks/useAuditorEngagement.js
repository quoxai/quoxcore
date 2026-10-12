/**
 * useAuditorEngagement — hook for external audit engagement lifecycle + PBC matching
 *
 * Backs the Auditor Portal tab (ComplianceView) against the real collector
 * endpoints in services/collector/lib/auditorPortal.js + server.js
 * (AUD-UX-6: /api/v1/auditor/engagements, /api/v1/auditor/pbc-match).
 *
 * cc-auditor-portal: engagements + PBC match are real server-backed data.
 * Working papers have no server-side generation endpoint yet — this hook
 * intentionally does NOT fabricate them; callers should pass an empty list.
 */

import { useState, useEffect, useCallback } from 'react'

const BASE = '/collector/api/v1/auditor'

export function useAuditorEngagement(orgId = '') {
  const [engagements, setEngagements] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [pbcResults, setPbcResults] = useState([])
  const [pbcLoading, setPbcLoading] = useState(false)
  const [pbcError, setPbcError] = useState(null)

  const fetchList = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${BASE}/engagements?org_id=${encodeURIComponent(orgId)}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to list engagements: ${res.status}`)
      const data = await res.json()
      setEngagements(data.engagements || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [orgId])

  const createEngagement = useCallback(async (opts = {}) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${BASE}/engagements`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, ...opts }),
      })
      if (!res.ok) throw new Error(`Failed to create engagement: ${res.status}`)
      const data = await res.json()
      await fetchList()
      return data.engagement
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [orgId, fetchList])

  const updateEngagementStatus = useCallback(async (id, status) => {
    try {
      const res = await fetch(`${BASE}/engagements/${id}/status`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) throw new Error(`Failed to update engagement status: ${res.status}`)
      const data = await res.json()
      await fetchList()
      return data.engagement
    } catch (err) {
      setError(err.message)
      return null
    }
  }, [fetchList])

  const matchPbc = useCallback(async (items) => {
    setPbcLoading(true)
    setPbcError(null)
    try {
      const res = await fetch(`${BASE}/pbc-match`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) throw new Error(`Failed to match PBC list: ${res.status}`)
      const data = await res.json()
      setPbcResults(data.results || [])
      return data.results || []
    } catch (err) {
      setPbcError(err.message)
      return []
    } finally {
      setPbcLoading(false)
    }
  }, [])

  useEffect(() => { fetchList() }, [fetchList])

  return {
    engagements,
    loading,
    error,
    createEngagement,
    updateEngagementStatus,
    pbcResults,
    pbcLoading,
    pbcError,
    matchPbc,
    refresh: fetchList,
  }
}
