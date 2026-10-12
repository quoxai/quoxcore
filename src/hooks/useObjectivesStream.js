/**
 * useObjectivesStream - Real-time objective/task updates via Server-Sent Events
 *
 * Mirrors useInboxStream pattern: exponential backoff, stable callback refs,
 * network status integration, auto-cleanup on unmount.
 *
 * Phase 4.B
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import useNetworkStatus from './useNetworkStatus'

const TASKS_BASE = '/tasks'
const BASE_RECONNECT_DELAY = 1000
const MAX_RECONNECT_DELAY = 60000

const EVENT_TYPES = [
  'connected', 'decomposition_started', 'decomposition_completed',
  'task_started', 'task_completed', 'task_failed', 'task_skipped',
  'task_heartbeat', 'task_retry_queued',
  'kickback_decision', 'objective_aborted',
  'checkpoint_created', 'checkpoint_approved', 'checkpoint_rejected',
  'budget_warning', 'objective_completed', 'objective_failed',
  'objective_paused', 'objective_resumed', 'objective_cancelled',
  'objective_started', 'plan_rejected',
  'volt_bundle_created'
]

function safeJsonParse(data) {
  try { return JSON.parse(data) }
  catch { return null }
}

/**
 * @param {string|null} objectiveId - Objective to subscribe to (null = no connection)
 * @param {object} options
 * @param {function} options.onEvent - (type, data) callback for all events
 * @param {boolean} [options.autoReconnect=true]
 * @returns {{ connectionState: string, lastEvent: object|null, error: string|null, reconnect: function, disconnect: function }}
 */
export default function useObjectivesStream(objectiveId, options = {}) {
  const { isOnline, wasOffline } = useNetworkStatus()
  const [connectionState, setConnectionState] = useState('disconnected') // connecting, connected, disconnected, error
  const [lastEvent, setLastEvent] = useState(null)
  const [error, setError] = useState(null)

  const eventSourceRef = useRef(null)
  const reconnectTimeoutRef = useRef(null)
  const reconnectAttemptRef = useRef(0)

  // Stable callback ref
  const callbackRef = useRef(options.onEvent)
  useEffect(() => { callbackRef.current = options.onEvent }, [options.onEvent])

  const { autoReconnect = true } = options

  const connect = useCallback(() => {
    if (!objectiveId || !isOnline) return

    // Close existing
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    try {
      setConnectionState('connecting')
      const url = `${TASKS_BASE}/api/objectives/${objectiveId}/stream`
      const eventSource = new EventSource(url, { withCredentials: true })
      eventSourceRef.current = eventSource

      eventSource.onopen = () => {
        setConnectionState('connected')
        setError(null)
        reconnectAttemptRef.current = 0
      }

      eventSource.onerror = () => {
        setConnectionState('error')
        setError('Connection lost')

        eventSource.close()
        eventSourceRef.current = null

        if (autoReconnect && isOnline) {
          const delay = Math.min(
            BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttemptRef.current),
            MAX_RECONNECT_DELAY
          )
          reconnectAttemptRef.current++
          reconnectTimeoutRef.current = setTimeout(() => connect(), delay)
        }
      }

      // Register all event listeners
      for (const type of EVENT_TYPES) {
        eventSource.addEventListener(type, (e) => {
          const data = safeJsonParse(e.data)
          if (data) {
            setLastEvent({ type, data, timestamp: Date.now() })
            callbackRef.current?.(type, data)
          }
        })
      }

    } catch (err) {
      setError(err.message)
      setConnectionState('error')
    }
  }, [objectiveId, isOnline, autoReconnect])

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    reconnectAttemptRef.current = 0
    setConnectionState('disconnected')
  }, [])

  // Connect on mount / objectiveId change
  useEffect(() => {
    if (objectiveId) connect()
    else disconnect()
    return () => disconnect()
  }, [objectiveId, connect, disconnect])

  // Auto-reconnect when coming back online
  useEffect(() => {
    if (wasOffline && objectiveId && connectionState !== 'connected') {
      connect()
    }
  }, [wasOffline, objectiveId, connectionState, connect])

  return {
    connectionState,
    lastEvent,
    error,
    reconnect: connect,
    disconnect
  }
}
