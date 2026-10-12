/**
 * useQuoxBoxData — React hook for the QuoxBox governed Mac-mini gateway
 *
 * Fetches live gateway state (mode, screen/capture, kill-switch, breaker,
 * pending HITL approvals, tasks, evidence chain, event feed) from the
 * collector proxy at /collector/api/quoxbox/*. Auto-refreshes at a
 * configurable interval. Org-scoped, credentials included. Follows the
 * useTailscaleData pattern.
 *
 * All state comes from the server-side collector proxy — no browser-only
 * persistence.
 */

import { useState, useEffect, useCallback, useRef } from 'react'

const DEFAULT_POLL_INTERVAL = 3000 // 3 seconds — live status
const PROXY_BASE = '/collector/api/quoxbox'

async function api(path, options = {}) {
  const orgId = localStorage.getItem('current_org_id') || 'default'
  const resp = await fetch(`${PROXY_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Org-Id': orgId,
      ...(options.headers || {}),
    },
    ...options,
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${resp.status}`)
    err.status = resp.status
    err.data = data
    throw err
  }
  return data
}

export default function useQuoxBoxData({ autoPoll = true, pollInterval = DEFAULT_POLL_INTERVAL } = {}) {
  const [live, setLive] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const mountedRef = useRef(true)
  const timerRef = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const data = await api('/live')
      if (!mountedRef.current) return
      setLive(data)
      setError(null)
    } catch (err) {
      if (mountedRef.current) setError(err.message)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    refresh()
    if (autoPoll && pollInterval > 0) {
      timerRef.current = setInterval(refresh, pollInterval)
    }
    return () => {
      mountedRef.current = false
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ──
  const listWorkflows = useCallback(async () => {
    const data = await api('/workflows')
    return data.workflows || []
  }, [])

  const runTask = useCallback(async (workflow, params = {}) => {
    const data = await api('/task/run', {
      method: 'POST',
      body: JSON.stringify({ workflow, params }),
    })
    return data.task || null
  }, [])

  const getTask = useCallback(async (taskId) => {
    const data = await api(`/task/${encodeURIComponent(taskId)}`)
    return data.task || null
  }, [])

  const approve = useCallback(async (pendingId) => {
    const data = await api(`/approve/${encodeURIComponent(pendingId)}`, { method: 'POST' })
    refresh()
    return data
  }, [refresh])

  const deny = useCallback(async (pendingId) => {
    const data = await api(`/deny/${encodeURIComponent(pendingId)}`, { method: 'POST' })
    refresh()
    return data
  }, [refresh])

  const setMode = useCallback(async (mode) => {
    const data = await api('/mode', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    })
    refresh()
    return data
  }, [refresh])

  return {
    live,
    loading,
    error,
    refresh,
    listWorkflows,
    runTask,
    getTask,
    approve,
    deny,
    setMode,
  }
}
