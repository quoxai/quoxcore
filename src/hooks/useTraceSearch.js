/**
 * TRV-4: useTraceSearch — data hook for trace search + pagination
 */

import { useState, useEffect, useCallback, useRef } from 'react'

const DEFAULT_FILTERS = {
  query: '',
  after: null,
  before: null,
  actor: null,
  outcome: null,
  has_denial: null,
  has_hitl: null,
  sort: 'newest',
}

export default function useTraceSearch(initialFilters = {}) {
  const [traces, setTraces] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [filters, setFilters] = useState({ ...DEFAULT_FILTERS, ...initialFilters })
  const [offset, setOffset] = useState(0)
  const limit = 30
  const abortRef = useRef(null)

  const search = useCallback(async () => {
    // Abort previous request
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      params.set('limit', limit)
      params.set('offset', offset)
      // quox#806: /traces no longer counts by default; the paginated UI needs the total.
      params.set('count', '1')
      if (filters.sort) params.set('sort', filters.sort)
      if (filters.after) params.set('after', filters.after)
      if (filters.before) params.set('before', filters.before)
      if (filters.actor) params.set('actor', filters.actor)
      if (filters.outcome) params.set('outcome', filters.outcome)
      if (filters.has_denial) params.set('has_denial', 'true')
      if (filters.has_hitl) params.set('has_hitl', 'true')

      const res = await fetch(`/collector/traces?${params}`, { signal: controller.signal })
      if (!res.ok) throw new Error(`Search failed (${res.status})`)
      const data = await res.json()

      let results = data.traces || []

      // Client-side query filter (free text search on query_preview)
      if (filters.query) {
        const q = filters.query.toLowerCase()
        results = results.filter(t =>
          (t.query_preview || '').toLowerCase().includes(q) ||
          (t.run_id || '').toLowerCase().includes(q) ||
          (t.corr || '').toLowerCase().includes(q) ||
          (t.actor?.display_name || '').toLowerCase().includes(q)
        )
      }

      setTraces(results)
      setTotal(data.total || results.length)
      setLoading(false)
    } catch (err) {
      if (err.name === 'AbortError') return
      setError(err.message)
      setLoading(false)
    }
  }, [filters, offset])

  useEffect(() => {
    search()
    return () => { if (abortRef.current) abortRef.current.abort() }
  }, [search])

  const updateFilter = useCallback((key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }))
    setOffset(0) // Reset pagination on filter change
  }, [])

  const clearFilters = useCallback(() => {
    setFilters({ ...DEFAULT_FILTERS })
    setOffset(0)
  }, [])

  const nextPage = useCallback(() => {
    if (offset + limit < total) setOffset(o => o + limit)
  }, [offset, total])

  const prevPage = useCallback(() => {
    setOffset(o => Math.max(0, o - limit))
  }, [])

  return {
    traces, total, loading, error,
    filters, setFilters, updateFilter, clearFilters,
    offset, setOffset, limit, nextPage, prevPage,
    search,
  }
}
