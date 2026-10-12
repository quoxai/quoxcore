/**
 * useMemoryActivity Hook
 *
 * Subscribes to memoryActivityEmitter and maintains a rolling buffer
 * of memory events for display in the MemoryActivityFeed component.
 *
 * Pattern: follows useTerminalErrorDetection.js — subscribe on mount,
 * unsubscribe on cleanup, mountedRef for safety.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { subscribe, getEvents } from '../services/memoryActivityEmitter'

const MAX_DISPLAY_EVENTS = 20
const COLLAPSE_KEY_PREFIX = 'quox_memory_feed_collapsed_'

/**
 * @param {string} workspaceId - Used to persist collapsed state per workspace
 * @returns {{ events, clearEvents, isCollapsed, toggleCollapsed, eventCount }}
 */
export default function useMemoryActivity(workspaceId) {
  const mountedRef = useRef(true)
  const [events, setEvents] = useState(() => getEvents().slice(-MAX_DISPLAY_EVENTS))
  const [isCollapsed, setIsCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem(`${COLLAPSE_KEY_PREFIX}${workspaceId}`)
      return stored === null ? true : stored === 'true'
    } catch {
      return true
    }
  })

  // Subscribe to emitter
  useEffect(() => {
    mountedRef.current = true

    const unsub = subscribe((event) => {
      if (!mountedRef.current) return
      setEvents(prev => {
        const next = [...prev, event]
        return next.length > MAX_DISPLAY_EVENTS ? next.slice(-MAX_DISPLAY_EVENTS) : next
      })
    })

    return () => {
      mountedRef.current = false
      unsub()
    }
  }, [])

  // Persist collapsed state
  const toggleCollapsed = useCallback(() => {
    setIsCollapsed(prev => {
      const next = !prev
      try {
        localStorage.setItem(`${COLLAPSE_KEY_PREFIX}${workspaceId}`, String(next))
      } catch {
        // localStorage unavailable
      }
      return next
    })
  }, [workspaceId])

  const clearEvents = useCallback(() => {
    setEvents([])
  }, [])

  return {
    events,
    clearEvents,
    isCollapsed,
    toggleCollapsed,
    eventCount: events.length,
  }
}
