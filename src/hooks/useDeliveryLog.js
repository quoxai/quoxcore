/**
 * useDeliveryLog Hook
 *
 * Paginated fetch with filters for notification delivery log.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useWorkspace } from '../contexts/WorkspaceContext'
import { useAuth } from '../contexts/AuthContext'

export function useDeliveryLog(filters = {}) {
  const { currentOrg } = useWorkspace()
  const { authFetch } = useAuth()
  const orgId = currentOrg?.id
  const mountedRef = useRef(true)

  const [deliveries, setDeliveries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)

  const fetchDeliveries = useCallback(async (pageNum = 1) => {
    if (!orgId) return
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: pageNum, limit: 25 })
      if (filters.status) params.set('status', filters.status)
      if (filters.channel_type) params.set('channel_type', filters.channel_type)

      const resp = await authFetch(`/api/orgs/${orgId}/notification-deliveries?${params}`)
      if (!resp.ok) throw new Error('Failed to fetch delivery log')
      const data = await resp.json()
      if (!mountedRef.current) return

      setDeliveries(data.data || data.items || [])
      setTotal(data.pagination?.total || data.total || 0)
      setTotalPages(data.pagination?.total_pages || Math.ceil((data.total || 0) / 25) || 1)
      setPage(pageNum)
      setError(null)
    } catch (err) {
      if (mountedRef.current) setError(err.message)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [orgId, authFetch, filters.status, filters.channel_type])

  useEffect(() => {
    mountedRef.current = true
    fetchDeliveries(1)
    return () => { mountedRef.current = false }
  }, [fetchDeliveries])

  const goToPage = useCallback((p) => {
    fetchDeliveries(p)
  }, [fetchDeliveries])

  const retry = useCallback(async (deliveryId) => {
    if (!orgId) return false
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/notification-deliveries/${deliveryId}/retry`, {
        method: 'POST'
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.error || 'Retry failed')
      }
      // Refresh current page
      fetchDeliveries(page)
      return true
    } catch (err) {
      setError(err.message)
      return false
    }
  }, [orgId, authFetch, fetchDeliveries, page])

  return {
    deliveries,
    loading,
    error,
    page,
    totalPages,
    total,
    goToPage,
    retry,
    refresh: () => fetchDeliveries(page)
  }
}
