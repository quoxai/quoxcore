/**
 * useWardData — React hook for WARD chain data
 *
 * Fetches WARD stats, entries, chains, and verification results
 * from the collector /ward/* API endpoints.
 */

import { useState, useEffect, useCallback, useRef } from 'react'

const BASE = '/collector/ward'

/**
 * The chain to show when the user hasn't picked one. The view has no chain
 * switcher yet, so this default is the only chain a user ever sees — array
 * order once surfaced a 2-entry external witness chain ahead of the
 * production chain with millions of receipts, hiding every tip (and the
 * Quox Verified badge). Busiest chain wins; array order only breaks ties.
 */
export function defaultChainId(chains) {
  if (!Array.isArray(chains) || chains.length === 0) return null
  let best = chains[0]
  for (const c of chains) {
    if ((c.entry_count || 0) > (best.entry_count || 0)) best = c
  }
  return best.chain_id || null
}

async function fetchJSON(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`WARD API ${res.status}`)
  const text = await res.text()
  try { return JSON.parse(text) }
  catch { throw new Error(`WARD API: invalid JSON`) }
}

export default function useWardData() {
  const [stats, setStats] = useState(null)
  const [chains, setChains] = useState([])
  const [entries, setEntries] = useState([])
  const [breakdown, setBreakdown] = useState([])
  const [tips, setTips] = useState([])
  const [selectedEntry, setSelectedEntry] = useState(null)
  const [selectedChain, setSelectedChain] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [pagination, setPagination] = useState({ total: 0, limit: 50, offset: 0 })
  const [filters, setFilters] = useState({ source_kind: '', chain: '' })
  const [verifyResult, setVerifyResult] = useState(null)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const [statsRes, chainsRes] = await Promise.all([
        fetchJSON(`${BASE}/stats`),
        fetchJSON(`${BASE}/chains`)
      ])

      if (!mountedRef.current) return
      setStats(statsRes)
      setChains(chainsRes.chains || [])

      // Auto-select the busiest chain if none selected (see defaultChainId)
      const activeChain = filters.chain || defaultChainId(chainsRes.chains)
      if (activeChain) {
        setSelectedChain(activeChain)

        const params = new URLSearchParams({ chain: activeChain, limit: '50', offset: '0' })
        if (filters.source_kind) params.set('source_kind', filters.source_kind)

        const [entriesRes, breakdownRes, tipsRes] = await Promise.all([
          fetchJSON(`${BASE}/entries?${params}`),
          fetchJSON(`${BASE}/source-breakdown?chain=${activeChain}`),
          fetchJSON(`${BASE}/tips?chain=${activeChain}`)
        ])

        if (!mountedRef.current) return
        setEntries(entriesRes.entries || [])
        setPagination({ total: entriesRes.total, limit: entriesRes.limit, offset: entriesRes.offset })
        setBreakdown(breakdownRes.breakdown || [])
        setTips(tipsRes.tips || [])
      }
    } catch (err) {
      if (mountedRef.current) setError(err.message)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [filters])

  const loadMore = useCallback(async () => {
    if (!selectedChain) return
    const nextOffset = pagination.offset + pagination.limit
    if (nextOffset >= pagination.total) return

    const params = new URLSearchParams({
      chain: selectedChain, limit: '50', offset: String(nextOffset)
    })
    if (filters.source_kind) params.set('source_kind', filters.source_kind)

    try {
      const res = await fetchJSON(`${BASE}/entries?${params}`)
      if (!mountedRef.current) return
      setEntries(prev => [...prev, ...(res.entries || [])])
      setPagination({ total: res.total, limit: res.limit, offset: nextOffset })
    } catch { /* ignore */ }
  }, [selectedChain, pagination, filters])

  const verify = useCallback(async (chainId) => {
    try {
      const res = await fetch(`${BASE}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain_id: chainId || selectedChain })
      })
      const data = await res.json()
      if (mountedRef.current) setVerifyResult(data.result)
      return data.result
    } catch (err) {
      const failResult = { status: 'ERROR', reason: err.message }
      if (mountedRef.current) setVerifyResult(failResult)
      return failResult
    }
  }, [selectedChain])

  const selectEntry = useCallback((entry) => {
    setSelectedEntry(entry)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedEntry(null)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    refresh()
    return () => { mountedRef.current = false }
  }, [refresh])

  return {
    stats, chains, entries, breakdown, tips,
    selectedEntry, selectedChain, setSelectedChain,
    loading, error, pagination, filters, setFilters,
    verifyResult, setVerifyResult,
    refresh, loadMore, verify,
    selectEntry, clearSelection
  }
}
