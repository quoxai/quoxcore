/**
 * useVoltData — React hook for VOLT dashboard data
 *
 * SERVER-FIRST: volt.db (via the collector) is the authoritative,
 * tamper-evident source of truth. IndexedDB (volt-store) is an offline
 * cache ONLY, used as a fallback when the server is unreachable.
 * Bundling (volt-bundler) and verification (volt-verify) are wrapped
 * behind a clean hook API.
 *
 * Usage:
 *   const { runs, stats, loading, selectedRun, ... } = useVoltData()
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  loadRuns,
  queryRuns,
  getStoreStats,
  loadRunEvents,
  loadBundleByRunId,
  persistBundle
} from '../lib/volt/volt-store.js'
import {
  fetchVoltStats,
  fetchVoltRuns,
  fetchVoltRunEvents,
  fetchVoltBundle,
  createVoltBundleOnServer
} from '../lib/volt/volt-api.js'
import { createBundle, serializeBundle } from '../lib/volt/volt-bundler.js'
import { verifyEvidenceBundle } from '../lib/volt/volt-verify.js'
import { getRunSnapshot } from '../lib/volt/volt-recorder.js'
import { getBridgeStats } from '../lib/volt/volt-bridge.js'

const EMPTY_STATS = { runs: 0, events: 0, bundles: 0 }
const EMPTY_BRIDGE = { enabled: false, eventsRecorded: 0, eventsFailed: 0, runsStarted: 0, runsCompleted: 0, envelopesProcessed: 0, activeCorrelations: 0, enabledAt: null }

// Back-compat local aliases (server is primary; IndexedDB fallback lives below)
const loadRunsFromServer = fetchVoltRuns
const getStatsFromServer = fetchVoltStats
const loadRunEventsFromServer = fetchVoltRunEvents

export default function useVoltData() {
  // ── List state ──────────────────────────────────────────────
  const [runs, setRuns] = useState([])
  const [stats, setStats] = useState(EMPTY_STATS)
  const [bridgeStats, setBridgeStats] = useState(EMPTY_BRIDGE)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [pagination, setPagination] = useState({ total: 0, offset: 0, limit: 30 })

  // ── Filter state ────────────────────────────────────────────
  const [filters, setFilters] = useState({
    status: '',
    corr: '',
    after: '',
    before: ''
  })

  // ── Detail state ────────────────────────────────────────────
  const [selectedRun, setSelectedRun] = useState(null)
  const [selectedEvents, setSelectedEvents] = useState([])
  const [eventsLoading, setEventsLoading] = useState(false)

  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  // ── Load / refresh runs (server-first with IndexedDB fallback) ──
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let data = []
      const hasFilters = Object.values(filters).some(v => v)

      // Try server first (has full synced history)
      if (!hasFilters) {
        try {
          const result = await loadRunsFromServer(30, 0)
          data = result.runs || []
          if (mountedRef.current) {
            setPagination({ total: result.total || data.length, offset: 0, limit: result.limit || 30 })
          }
        } catch (serverErr) {
          console.warn('[VOLT] Server unavailable, falling back to IndexedDB:', serverErr.message)
        }
      }

      // Fallback or filtered query from IndexedDB
      if (data.length === 0) {
        try {
          data = hasFilters ? await queryRuns(filters) : await loadRuns()
        } catch (localErr) {
          console.warn('[VOLT] IndexedDB also unavailable:', localErr.message)
        }
      }

      // Sort newest first
      data.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))
      if (!mountedRef.current) return
      setRuns(data)

      // Stats: try server first
      try {
        const serverStats = await getStatsFromServer()
        if (mountedRef.current) setStats(serverStats)
      } catch {
        try {
          const s = await getStoreStats()
          if (mountedRef.current) setStats(s)
        } catch { /* both failed */ }
      }

      if (mountedRef.current) setBridgeStats(getBridgeStats())
    } catch (err) {
      if (mountedRef.current) setError(err.message)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [filters])

  useEffect(() => { refresh() }, [refresh])

  // ── Load more (pagination) ──────────────────────────────────
  const loadMore = useCallback(async () => {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      const nextOffset = pagination.offset + pagination.limit
      const result = await loadRunsFromServer(pagination.limit, nextOffset)
      if (mountedRef.current && result.runs?.length > 0) {
        setRuns(prev => {
          const existingIds = new Set(prev.map(r => r.run_id))
          const newRuns = result.runs.filter(r => !existingIds.has(r.run_id))
          return [...prev, ...newRuns]
        })
        setPagination({ total: result.total, offset: nextOffset, limit: result.limit || pagination.limit })
      }
    } catch (err) {
      console.error('[VOLT] Failed to load more:', err)
    } finally {
      if (mountedRef.current) setLoadingMore(false)
    }
  }, [pagination, loadingMore])

  const clearFilters = useCallback(() => {
    setFilters({ status: '', corr: '', after: '', before: '' })
  }, [])

  // ── Select a run (server-first with IndexedDB fallback) ────
  const selectRun = useCallback(async (run) => {
    setSelectedRun(run)
    setSelectedEvents([])
    if (!run) return
    setEventsLoading(true)
    try {
      let events = []
      try {
        events = await loadRunEventsFromServer(run.run_id)
      } catch {
        events = await loadRunEvents(run.run_id)
      }
      if (mountedRef.current) setSelectedEvents(events)
    } catch (err) {
      console.error('[VOLT] Failed to load events:', err)
    } finally {
      if (mountedRef.current) setEventsLoading(false)
    }
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedRun(null)
    setSelectedEvents([])
  }, [])

  // ── Resolve a run's evidence bundle — SERVER-FIRST ──────────
  // 1. Server-stored bundle (already certified/created).
  // 2. Ask the server to assemble one from its own durable event log.
  // 3. Offline fallback: reconstruct from IndexedDB cache only when the
  //    server itself is unreachable (never as the default path).
  const resolveBundle = useCallback(async (run) => {
    let serialized = await fetchVoltBundle(run.run_id)
    if (serialized) return serialized

    try {
      await createVoltBundleOnServer(run.run_id)
      serialized = await fetchVoltBundle(run.run_id)
      if (serialized) return serialized
    } catch (err) {
      console.warn('[VOLT] Server bundle creation unavailable, falling back to offline cache:', err.message)
    }

    // Offline fallback — server unreachable or has no events for this run
    serialized = await loadBundleByRunId(run.run_id)
    if (serialized) return serialized

    let runSnapshot = getRunSnapshot(run.run_id)
    if (!runSnapshot) {
      let events = []
      try {
        events = await fetchVoltRunEvents(run.run_id)
      } catch {
        events = await loadRunEvents(run.run_id)
      }
      runSnapshot = {
        run_id: run.run_id,
        corr: run.corr,
        seq: run.seq,
        head_hash: run.head_hash,
        events,
        status: run.status,
        started_at: run.started_at,
        completed_at: run.completed_at
      }
    }

    const bundle = await createBundle({ run: runSnapshot })
    serialized = serializeBundle(bundle)
    await persistBundle(serialized)
    return serialized
  }, [])

  // ── Export bundle ───────────────────────────────────────────
  const exportBundle = useCallback(async (run) => {
    if (!run) throw new Error('No run to export')

    const serialized = await resolveBundle(run)

    // Download as JSON
    const json = JSON.stringify(serialized, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `volt-bundle-${run.run_id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [resolveBundle])

  // ── Verify run ──────────────────────────────────────────────
  const verifyRun = useCallback(async (run) => {
    if (!run) throw new Error('No run to verify')

    const serialized = await resolveBundle(run)
    const result = await verifyEvidenceBundle(JSON.stringify(serialized))
    return result
  }, [resolveBundle])

  // ── Import / verify bundle ──────────────────────────────────
  const importBundle = useCallback(async (jsonString) => {
    const result = await verifyEvidenceBundle(jsonString)
    return result
  }, [])

  return {
    // List
    runs, stats, bridgeStats, loading, loadingMore, error, pagination,
    // Filters
    filters, setFilters, clearFilters,
    // Detail
    selectedRun, selectedEvents, eventsLoading,
    selectRun, clearSelection,
    // Actions
    refresh, loadMore, exportBundle, verifyRun, importBundle
  }
}
