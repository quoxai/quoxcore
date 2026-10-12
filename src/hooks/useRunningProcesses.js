/**
 * useRunningProcesses — Tracks all active AI processes across the platform.
 *
 * Merges:
 * - QuoxFlow objective executions (polled from backend)
 * - Active chat sessions (from in-memory activeAIRegistry)
 *
 * Used by AIRunningIndicator in the AppShell header.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { listExecutions } from '../services/quoxflowClient'
import { useActiveAI } from '../services/activeAIRegistry'

const POLL_INTERVAL = 15000 // 15s
const STALE_THRESHOLD = 10 * 60 * 1000  // 10 min — amber
const STUCK_THRESHOLD = 30 * 60 * 1000  // 30 min — red

/**
 * Convert QuoxFlow executions into the process shape.
 * Exported for testability (QE2 Phase 6).
 */
export function mergeQuoxFlowExecutions(executions) {
  if (!Array.isArray(executions)) return []
  const now = Date.now()

  return executions.map(exec => {
    const startedAt = exec.startedAt || exec.created_at
    const elapsed = startedAt ? now - new Date(startedAt).getTime() : 0
    const lastEvent = exec.updatedAt ? now - new Date(exec.updatedAt).getTime() : elapsed

    let health = 'active'
    if (lastEvent > STUCK_THRESHOLD) health = 'stuck'
    else if (lastEvent > STALE_THRESHOLD) health = 'stale'

    const title = (exec.workflowName || '').replace(/^Objective:\s*/i, '') || 'Untitled'

    return {
      id: exec.id,
      title,
      type: 'objective',
      agent: exec.metadata?.agentId || null,
      status: exec.status,
      health,
      elapsed,
      lastEvent,
      startedAt,
      taskCount: exec.nodeCount || 0,
      completedTasks: 0,
    }
  })
}

export function useRunningProcesses() {
  const [objectiveProcesses, setObjectiveProcesses] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const mountedRef = useRef(true)

  // Active chats from the global registry (reactive, no polling needed)
  const { entries: activeAI } = useActiveAI()

  const fetchRunning = useCallback(async () => {
    try {
      // QE2: QuoxFlow is the sole execution engine
      const qfResult = await listExecutions({ tag: 'objective', status: 'running', limit: 20 })
      const qfList = Array.isArray(qfResult) ? qfResult : (qfResult?.data || [])
      const processes = mergeQuoxFlowExecutions(qfList)

      if (mountedRef.current) {
        setObjectiveProcesses(processes)
        setError(null)
        setLoading(false)
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err.message)
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    fetchRunning()
    const interval = setInterval(fetchRunning, POLL_INTERVAL)
    return () => {
      mountedRef.current = false
      clearInterval(interval)
    }
  }, [fetchRunning])

  // Convert active AI registry entries into process shape
  const chatProcesses = activeAI
    .filter(ai => ai.type === 'chat')
    .map(ai => ({
      id: ai.id,
      title: ai.label || `Chat: ${ai.agent}`,
      type: 'chat',
      agent: ai.agent,
      status: 'running',
      health: 'active',
      elapsed: Date.now() - ai.startedAt,
      startedAt: ai.startedAt,
      taskCount: 0,
      completedTasks: 0,
    }))

  // Merge all process types
  const allProcesses = [...chatProcesses, ...objectiveProcesses]

  const runningCount = allProcesses.length
  const staleCount = allProcesses.filter(p => p.health === 'stale').length
  const stuckCount = allProcesses.filter(p => p.health === 'stuck').length

  // Breakdown by type
  const chatCount = chatProcesses.length
  const objectiveCount = objectiveProcesses.length

  return {
    processes: allProcesses,
    runningCount,
    staleCount,
    stuckCount,
    chatCount,
    objectiveCount,
    loading,
    error,
    refresh: fetchRunning,
  }
}

/**
 * Format elapsed time as human-readable string.
 */
export function formatElapsed(ms) {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}
