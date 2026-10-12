/**
 * useEventStream — Real-time unified event stream via WebSocket
 *
 * Connects to the collector's /api/v1/stream/events WebSocket endpoint
 * and receives AEE envelopes from all sources (chat, bastion, fleet, workflow).
 * Supports filtering by layer and entity.
 *
 * Created: CLI-3.5A (Stream CLI Phase 3.5)
 */

import { useState, useEffect, useRef, useCallback } from 'react'

const COLLECTOR_WS = import.meta.env.VITE_COLLECTOR_WS_URL || (
  typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
    : 'ws://localhost:9848'
)

const BASE_RECONNECT_DELAY = 1000
const MAX_RECONNECT_DELAY = 30000

/**
 * @param {Object} [options]
 * @param {string[]} [options.layers] - Filter by intent prefix (e.g., ['bastion', 'fleet'])
 * @param {string} [options.entity] - Filter by entity ID (e.g., 'docker01')
 * @param {Function} [options.onEvent] - Callback for each received event
 * @param {boolean} [options.autoReconnect=true] - Auto-reconnect on disconnect
 * @returns {{connected: boolean, lastEvent: Object|null, eventCount: number}}
 */
export default function useEventStream(options = {}) {
  const { layers, entity, onEvent, autoReconnect = true } = options

  const [connected, setConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState(null)
  const [eventCount, setEventCount] = useState(0)

  const wsRef = useRef(null)
  const reconnectRef = useRef(null)
  const reconnectDelayRef = useRef(BASE_RECONNECT_DELAY)
  const mountedRef = useRef(true)
  const onEventRef = useRef(onEvent)

  // Keep onEvent ref current without re-triggering effect
  useEffect(() => { onEventRef.current = onEvent }, [onEvent])

  const connect = useCallback(() => {
    if (!mountedRef.current) return

    // Build WebSocket URL with filters
    const params = new URLSearchParams()
    if (layers?.length) params.set('layers', layers.join(','))
    if (entity) params.set('entity', entity)
    const qs = params.toString()
    const url = `${COLLECTOR_WS}/api/v1/stream/events${qs ? '?' + qs : ''}`

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      if (!mountedRef.current) return
      setConnected(true)
      reconnectDelayRef.current = BASE_RECONNECT_DELAY
    }

    ws.onmessage = (event) => {
      if (!mountedRef.current) return
      try {
        const data = JSON.parse(event.data)
        setLastEvent(data)
        setEventCount(c => c + 1)
        if (onEventRef.current) onEventRef.current(data)
      } catch { /* ignore malformed messages */ }
    }

    ws.onclose = () => {
      if (!mountedRef.current) return
      setConnected(false)
      if (autoReconnect) {
        reconnectRef.current = setTimeout(() => {
          reconnectDelayRef.current = Math.min(
            reconnectDelayRef.current * 2,
            MAX_RECONNECT_DELAY
          )
          connect()
        }, reconnectDelayRef.current)
      }
    }

    ws.onerror = () => {
      // onclose will fire after onerror
    }
  }, [layers?.join(','), entity, autoReconnect])

  useEffect(() => {
    mountedRef.current = true
    connect()

    return () => {
      mountedRef.current = false
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (wsRef.current) wsRef.current.close()
    }
  }, [connect])

  return { connected, lastEvent, eventCount }
}
