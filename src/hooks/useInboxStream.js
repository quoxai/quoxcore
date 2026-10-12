/**
 * useInboxStream - Real-time inbox updates via Server-Sent Events
 *
 * Provides real-time updates for inbox items via SSE. The stream has no ids or
 * replay, so resilience lives in ./inboxStreamReconnect: on error it refreshes
 * the auth token and reconnects with capped backoff + jitter, reconnects on
 * tab-visible / online, watches for silence (server sends `event: ping`), and
 * polls every 30s while disconnected. Every reopen after the first refetches
 * state so items emitted while disconnected are not lost.
 *
 * H17 fix: Stabilized callback refs to prevent infinite reconnection
 * H18 fix: Exponential backoff for reconnection attempts
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { subscribeSharedStream } from './inboxStreamReconnect'
import { serverFilterQs, applyResponded } from '../components/inbox/inboxFolders'

const INBOX_EVENT_TYPES = ['item_created', 'item_updated', 'item_responded', 'stats_updated']

// Use relative URL — nginx proxies /api/orgs to auth:3101 in production
const AUTH_API = import.meta.env.VITE_AUTH_API_URL || '/api'

/**
 * Safe JSON parse with error handling
 */
function safeJsonParse(data, fallback = null) {
  try {
    return JSON.parse(data)
  } catch (err) {
    console.error('[InboxStream] JSON parse error:', err)
    return fallback
  }
}

export default function useInboxStream(orgId, options = {}) {
  const { isAuthenticated, isDevMode, refreshToken } = useAuth()
  const [connected, setConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState(null)
  const [error, setError] = useState(null)
  const streamRef = useRef(null)

  // H17 fix: Store callbacks in refs to prevent useCallback deps from changing
  const callbacksRef = useRef({})
  callbacksRef.current = {
    onItemCreated: options.onItemCreated,
    onItemUpdated: options.onItemUpdated,
    onItemResponded: options.onItemResponded,
    onStatsUpdated: options.onStatsUpdated,
    onReconnect: options.onReconnect,
    onPoll: options.onPoll,
    onEvent: options.onEvent,
  }
  const refreshTokenRef = useRef(refreshToken)
  refreshTokenRef.current = refreshToken

  const connect = useCallback(() => {
    if (!orgId || !isAuthenticated || isDevMode) return
    streamRef.current?.stop()

    const handlerFor = {
      item_created: 'onItemCreated',
      item_updated: 'onItemUpdated',
      item_responded: 'onItemResponded',
      stats_updated: 'onStatsUpdated',
    }
    // Shared per-org stream (one EventSource per org per tab, refcounted).
    const stream = subscribeSharedStream({
      url: `${AUTH_API}/orgs/${orgId}/inbox/stream`,
      eventTypes: INBOX_EVENT_TYPES,
      refreshAuth: () => refreshTokenRef.current?.(),
      onStatus: (isUp, err) => {
        setConnected(isUp)
        setError(isUp ? null : err || 'Connection lost')
      },
      onReopen: () => callbacksRef.current.onReconnect?.(),
      onPoll: () => callbacksRef.current.onPoll?.(),
      onEvent: (type, e) => {
        const data = safeJsonParse(e.data)
        if (!data) return
        setLastEvent({ type, data, timestamp: Date.now() })
        callbacksRef.current[handlerFor[type]]?.(data)
        callbacksRef.current.onEvent?.(type, data)
      },
    })
    streamRef.current = stream
  }, [orgId, isAuthenticated, isDevMode])

  const disconnect = useCallback(() => {
    streamRef.current?.stop()
    streamRef.current = null
    setConnected(false)
  }, [])

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    connect()
    return () => disconnect()
  }, [connect, disconnect])

  return {
    connected,
    lastEvent,
    error,
    reconnect: connect,
    disconnect
  }
}

/**
 * useInboxWithRealtime - Combined polling + real-time updates
 *
 * Uses SSE for real-time updates; the stream wrapper polls while disconnected
 * and refetches on every reconnect. Merges real-time events with fetched data.
 *
 * options.onEvent(type, data): every item_created/item_updated/item_responded/
 *   stats_updated event. options.onReconnect(): after every reopen and poll tick,
 *   so the caller can refresh its own side data.
 */
export function useInboxWithRealtime(orgId, options = {}) {
  const [items, setItems] = useState([])
  const [stats, setStats] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pagination, setPagination] = useState({ page: 1, total: 0, total_pages: 1, has_more: false })
  const { authFetch, isAuthenticated } = useAuth()

  // Server-side folder filter (kind/status). Passing the active folder's filter
  // to the query means each folder — the main Inbox (no filter → all active
  // kinds) and each type folder (e.g. Approvals → kind=approval) — is COMPLETE
  // from the server and paginated within itself, instead of being a client-side
  // filter over only page 1 of the firehose (which hid older approvals when an
  // org had >50 active items). Serialized so it is a stable dep.
  const serverFilter = options.serverFilter || {}
  const filterQs = serverFilterQs(serverFilter)

  // Fetch current items (page 1 or specific page)
  const fetchItems = useCallback(async (page = 1, append = false) => {
    if (!orgId || !isAuthenticated) return

    if (append) setLoadingMore(true)

    try {
      const res = await authFetch(`${AUTH_API}/orgs/${orgId}/inbox?limit=50&page=${page}&include_snoozed=true${filterQs}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const newItems = data.items || []

      if (append) {
        setItems(prev => {
          // Deduplicate by id in case SSE added items between pages
          const existingIds = new Set(prev.map(i => i.id))
          const unique = newItems.filter(i => !existingIds.has(i.id))
          return [...prev, ...unique]
        })
      } else {
        setItems(newItems)
      }

      if (data.pagination) {
        setPagination(data.pagination)
      }
    } catch (err) {
      console.error('[InboxRealtime] Fetch error:', err)
    } finally {
      setLoadingMore(false)
    }
    // filterQs in deps: when the active folder's server filter changes,
    // fetchItems changes identity → the initial-fetch effect reruns → page 1
    // is refetched fresh for the new folder (setItems replaces, not appends).
  }, [orgId, isAuthenticated, authFetch, filterQs])

  // Load next page (append to existing items)
  const loadMore = useCallback(() => {
    if (pagination.has_more && !loadingMore) {
      fetchItems(pagination.page + 1, true)
    }
  }, [pagination, loadingMore, fetchItems])

  // Fetch current stats
  const fetchStats = useCallback(async () => {
    if (!orgId || !isAuthenticated) return

    try {
      const res = await authFetch(`${AUTH_API}/orgs/${orgId}/inbox/stats`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setStats(data)
    } catch (err) {
      console.error('[InboxRealtime] Stats error:', err)
    } finally {
      setLoading(false)
    }
  }, [orgId, isAuthenticated, authFetch])

  // Handle real-time events
  const handleItemCreated = useCallback((item) => {
    setItems(prev => (prev.some(i => i.id === item.id) ? prev : [item, ...prev]))
  }, [])

  // Handle item_updated for read/flag/snooze/archive state changes
  const handleItemUpdated = useCallback(({ id, ...changes }) => {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, ...changes } : item
    ))
  }, [])

  // H19 fix: Use actual status from event instead of hardcoding 'resolved'
  const handleItemResponded = useCallback((data) => {
    setItems(prev => prev.map(item =>
      item.id === data.id ? applyResponded(item, data) : item
    ))
  }, [])

  const handleStatsUpdated = useCallback(() => {
    fetchStats()
  }, [fetchStats])

  // Use SSE stream
  const resync = useCallback(() => {
    fetchItems(1, false)
    fetchStats()
    options.onReconnect?.()
  }, [fetchItems, fetchStats, options.onReconnect])
  const stream = useInboxStream(orgId, {
    onItemCreated: handleItemCreated,
    onItemUpdated: handleItemUpdated,
    onItemResponded: handleItemResponded,
    onStatsUpdated: handleStatsUpdated,
    onReconnect: resync,
    onPoll: resync,
    onEvent: options.onEvent,
  })

  // Initial fetch
  useEffect(() => {
    fetchItems(1, false)
    fetchStats()
  }, [fetchItems, fetchStats])

  return {
    items,
    stats,
    loading,
    loadingMore,
    pagination,
    loadMore,
    connected: stream.connected,
    refresh: () => { fetchItems(1, false); fetchStats(); }
  }
}

/**
 * useMultiOrgInboxStream - Fetch inbox items across multiple orgs
 *
 * Parallel-fetches items from each org, tags them with org_id,
 * merges + sorts by created_at desc. Opens SSE per org for real-time.
 */
export function useMultiOrgInboxStream(orgIds = [], options = {}) {
  const multiFilterQs = serverFilterQs(options.serverFilter || {})
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const { authFetch, isAuthenticated, refreshToken } = useAuth()
  const streamsRef = useRef([])
  const inflightRef = useRef(null)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const refreshTokenRef = useRef(refreshToken)
  refreshTokenRef.current = refreshToken

  // Fetch items from all orgs in parallel
  const fetchAll = useCallback(async () => {
    if (!orgIds.length || !isAuthenticated) { setLoading(false); return }

    try {
      const results = await Promise.allSettled(
        orgIds.map(async (orgId) => {
          // Page through every page (cap 20 x 100) so history is never silently truncated.
          const all = []
          for (let page = 1; page <= 20; page++) {
            const res = await authFetch(`${AUTH_API}/orgs/${orgId}/inbox?limit=100&page=${page}&include_snoozed=true${multiFilterQs}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json()
            all.push(...(data.items || []))
            if (!data.pagination?.has_more) break
          }
          return all.map(item => ({ ...item, org_id: item.org_id || orgId }))
        })
      )

      const merged = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value)
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))

      setItems(merged)
    } catch (err) {
      console.error('[MultiOrgInbox] Fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [orgIds.join(','), isAuthenticated, authFetch, multiFilterQs])

  const fetchAllRef = useRef(fetchAll)
  fetchAllRef.current = fetchAll

  // Coalesce: N org streams reconnecting/polling together share one fetch.
  const resync = useCallback(() => {
    if (!inflightRef.current) {
      inflightRef.current = Promise.resolve(fetchAllRef.current()).finally(() => { inflightRef.current = null })
    }
    optionsRef.current.onReconnect?.()
  }, [])

  // Handle real-time SSE events — update merged items list
  const handleEvent = useCallback((type, data) => {
    if (type === 'item_created') {
      setItems(prev => (prev.some(i => i.id === data.id) ? prev : [data, ...prev]))
    } else if (type === 'item_updated') {
      const { id, ...changes } = data
      setItems(prev => prev.map(item => item.id === id ? { ...item, ...changes } : item))
    } else if (type === 'item_responded') {
      setItems(prev => prev.map(item => item.id === data.id ? applyResponded(item, data) : item))
    } else if (type === 'stats_updated') {
      fetchAllRef.current()
    }
    optionsRef.current.onEvent?.(type, data)
  }, [])

  // Open resilient SSE connections per org (reconnect, token refresh, watchdog, poll)
  useEffect(() => {
    if (!orgIds.length || !isAuthenticated) return

    streamsRef.current.forEach(s => s.stop())
    streamsRef.current = []

    for (const orgId of orgIds) {
      const stream = subscribeSharedStream({
        url: `${AUTH_API}/orgs/${orgId}/inbox/stream`,
        eventTypes: INBOX_EVENT_TYPES,
        refreshAuth: () => refreshTokenRef.current?.(),
        onReopen: resync,
        onPoll: resync,
        onEvent: (evType, e) => {
          const parsed = safeJsonParse(e.data)
          if (parsed) handleEvent(evType, { ...parsed, org_id: parsed.org_id || orgId })
        },
      })
      streamsRef.current.push(stream)
    }

    return () => {
      streamsRef.current.forEach(s => s.stop())
      streamsRef.current = []
    }
  }, [orgIds.join(','), isAuthenticated, handleEvent, resync])

  // Initial fetch
  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  return { items, loading, refresh: fetchAll }
}

/**
 * useInboxNotifyStreams - the shell's "something new arrived" listener.
 *
 * INBOX-LIVE (2026-10-07): the shell used useInboxStream(currentOrg?.id), so
 * the toast, the QuoxSounds chime and the desktop notification only fired for
 * items in the CURRENT org. The owner's current org was examplepools while approvals
 * landed in QUOX DEVELOPMENT: the inbox list refetched on every event, but none
 * of the three ever fired. This hook listens to every org the user belongs to,
 * sharing the per-org streams with the inbox page hooks, and tags each item
 * with its org_id.
 */
export function useInboxNotifyStreams(orgIds = [], options = {}) {
  const { isAuthenticated, isDevMode, refreshToken } = useAuth()
  const optionsRef = useRef(options)
  optionsRef.current = options
  const refreshTokenRef = useRef(refreshToken)
  refreshTokenRef.current = refreshToken
  const key = (orgIds || []).filter(Boolean).join(',')

  useEffect(() => {
    if (!key || !isAuthenticated || isDevMode) return undefined
    const subs = key.split(',').map((orgId) => subscribeSharedStream({
      url: `${AUTH_API}/orgs/${orgId}/inbox/stream`,
      eventTypes: INBOX_EVENT_TYPES,
      refreshAuth: () => refreshTokenRef.current?.(),
      onEvent: (type, e) => {
        if (type !== 'item_created') return
        const data = safeJsonParse(e.data)
        if (data) optionsRef.current.onItemCreated?.({ ...data, org_id: data.org_id || orgId })
      },
    }))
    return () => subs.forEach((s) => s.stop())
  }, [key, isAuthenticated, isDevMode])
}
