/**
 * useObjectiveManager — Unified hook for objective list, detail, actions, and streaming
 *
 * Extracted from ObjectivesView.jsx (UX-2).
 * Eliminates duplicated state management between ObjectivesView and AgenticTeamView.
 *
 * Usage:
 *   const { objectives, detail, loading, error, actions, refresh, connectionState } =
 *     useObjectiveManager({ teamId, selectedId, statusFilter })
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import useObjectivesStream from './useObjectivesStream'
import {
  listObjectives, getObjective, createObjective,
  startObjective, cancelObjective, approvePlan, rejectPlan,
} from '../services/objectivesClient'

/**
 * Events that should trigger a detail + list refresh.
 * Exported for testing.
 *
 * CRITICAL: task_started is included here (was missing in original ObjectivesView).
 * This makes execution feel live — user sees "Running" as soon as a task starts,
 * not only when it completes.
 */
export const REFRESH_EVENTS = [
  'task_started',
  'task_completed',
  'task_failed',
  'task_skipped',
  'objective_completed',
  'objective_failed',
  'objective_started',
  'objective_rerun',
  'checkpoint_created',
  'checkpoint_approved',
  'checkpoint_rejected',
  'decomposition_started',
  'decomposition_completed',
  'plan_rejected',
  'objective_paused',
  'objective_resumed',
  'objective_cancelled',
  'budget_warning',
]

/**
 * @param {Object} options
 * @param {string} [options.teamId] — filter objectives to a specific team
 * @param {string} [options.selectedId] — currently selected objective ID
 * @param {string} [options.statusFilter] — filter by status
 * @returns {Object} { objectives, detail, loading, error, actions, refresh, connectionState }
 */
export function useObjectiveManager({ teamId, selectedId, statusFilter } = {}) {
  const { authFetch } = useAuth()

  const [objectives, setObjectives] = useState([])
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Heartbeat tracking — maps task_id → { elapsed_ms, ts }
  // Used by TaskRow components to show live elapsed time during execution
  const [taskHeartbeats, setTaskHeartbeats] = useState({})

  // Tracks whether the selected objective is currently decomposing
  // (between "Plan Tasks" click and decomposition_completed event)
  const [isDecomposing, setIsDecomposing] = useState(false)

  // Live clock tick — drives elapsed time display for running tasks
  const clockRef = useRef(null)
  const [now, setNow] = useState(Date.now())
  const hasRunningTasks = detail?.tasks?.some(t => t.status === 'running')
  useEffect(() => {
    if (hasRunningTasks) {
      clockRef.current = setInterval(() => setNow(Date.now()), 1000)
    } else {
      if (clockRef.current) clearInterval(clockRef.current)
      clockRef.current = null
    }
    return () => { if (clockRef.current) clearInterval(clockRef.current) }
  }, [hasRunningTasks])

  // =============================================
  // Fetch list
  // =============================================
  const fetchList = useCallback(async () => {
    try {
      const params = {}
      if (statusFilter) params.status = statusFilter
      if (teamId) params.team_id = teamId
      const data = await listObjectives(authFetch, params)
      setObjectives(data.objectives || [])
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [authFetch, statusFilter, teamId])

  // =============================================
  // Fetch detail
  // =============================================
  const fetchDetail = useCallback(async (id) => {
    if (!id) { setDetail(null); return }
    try {
      const data = await getObjective(authFetch, id)
      setDetail(data)
    } catch (err) {
      console.error('[useObjectiveManager] Detail fetch error:', err)
    }
  }, [authFetch])

  // Initial load
  useEffect(() => { fetchList() }, [fetchList])

  // Load detail when selection changes
  useEffect(() => { fetchDetail(selectedId) }, [selectedId, fetchDetail])

  // QE2: Poll for updates while objective is running (SSE stream was removed)
  useEffect(() => {
    if (!selectedId || !detail) return
    if (!['running', 'decomposing'].includes(detail.status)) return
    const interval = setInterval(() => {
      fetchDetail(selectedId)
      fetchList()
    }, 5000)
    return () => clearInterval(interval)
  }, [selectedId, detail?.status, fetchDetail, fetchList])

  // =============================================
  // SSE stream
  // =============================================
  // Stream for pending objectives too — catches decomposition_started event
  const shouldStream = selectedId && detail &&
    ['pending', 'running', 'paused', 'decomposed', 'decomposing'].includes(detail?.status)

  const handleStreamEvent = useCallback((type, data) => {
    // Track heartbeats per task (live elapsed time display)
    if (type === 'task_heartbeat') {
      setTaskHeartbeats(prev => ({
        ...prev,
        [data.task_id]: { elapsed_ms: data.elapsed_ms, ts: Date.now() }
      }))
      return // don't trigger full refresh for heartbeats
    }

    // Clear heartbeat for completed/failed tasks
    if (type === 'task_completed' || type === 'task_failed') {
      setTaskHeartbeats(prev => {
        const next = { ...prev }
        delete next[data.task_id]
        return next
      })
    }

    // Track decomposing state for UI skeleton
    if (type === 'decomposition_started') {
      setIsDecomposing(true)
    }
    if (type === 'decomposition_completed' || type === 'objective_failed') {
      setIsDecomposing(false)
    }

    // Refresh on significant events
    if (REFRESH_EVENTS.includes(type)) {
      fetchDetail(selectedId)
      fetchList()
    }
  }, [selectedId, fetchDetail, fetchList])

  const { connectionState } = useObjectivesStream(
    shouldStream ? selectedId : null,
    { onEvent: handleStreamEvent }
  )

  // =============================================
  // Refresh
  // =============================================
  const refresh = useCallback(() => {
    fetchDetail(selectedId)
    fetchList()
  }, [selectedId, fetchDetail, fetchList])

  // =============================================
  // Actions
  // =============================================
  const actions = {
    create: async (data, parentCorr) => {
      const result = await createObjective(authFetch, data, parentCorr)
      await fetchList()
      return result
    },
    start: async (id) => {
      setIsDecomposing(true)
      await startObjective(authFetch, id)
      refresh()
    },
    cancel: async (id) => {
      await cancelObjective(authFetch, id)
      refresh()
    },
    approvePlan: async (id) => {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Approve timed out after 15s')), 15000))
      await Promise.race([approvePlan(authFetch, id), timeout])
      refresh()
    },
    rejectPlan: async (id, feedback) => {
      await rejectPlan(authFetch, id, feedback)
      refresh()
    },
  }

  return {
    objectives,
    detail,
    loading,
    error,
    actions,
    refresh,
    connectionState,
    // UX-2: heartbeat + decomposing state for live execution display
    taskHeartbeats,
    isDecomposing,
    now,
  }
}
