/**
 * useExecutionOverlay — Live execution status overlay for the WireMap canvas.
 *
 * STUDY-REV-2 P5.B
 *
 * On mount with a valid executionId:
 *   1. Fetches past envelopes from /executions/:id/envelopes (replay).
 *   2. Subscribes to the collector WebSocket stream via useEventStream,
 *      filtering client-side by corr id extracted from the replay response.
 *
 * Returns:
 *   {
 *     nodeStatus: Map<nodeId, 'queued'|'running'|'completed'|'failed'|'skipped'>,
 *     runStatus:  null | 'running' | 'completed' | 'failed',
 *     error:      string | null,
 *     isReplay:   boolean,
 *   }
 *
 * Transport: the existing collector WebSocket at /api/v1/stream/events.
 * No new transports; no new QuoxFlow envelope types.
 */

import { useState, useEffect, useRef } from 'react'

// ─── intent constants (mirror quoxflow/src/core/envelope.ts) ────────────────
const INTENT = {
  NODE_STARTED:   'quox.flow.node.started',
  NODE_COMPLETED: 'quox.flow.node.completed',
  NODE_FAILED:    'quox.flow.node.failed',
  NODE_SKIPPED:   'quox.flow.node.skipped',
  FLOW_COMPLETED: 'quox.flow.completed',
  FLOW_FAILED:    'quox.flow.failed',
}

// ─── envelope → node status mapping ─────────────────────────────────────────
const INTENT_TO_STATUS = {
  [INTENT.NODE_STARTED]:   'running',
  [INTENT.NODE_COMPLETED]: 'completed',
  [INTENT.NODE_FAILED]:    'failed',
  [INTENT.NODE_SKIPPED]:   'skipped',
}

/**
 * Resolve the correlation id from a replay response.
 * /executions/:id/envelopes returns:
 *   { success, data: { correlationId, envelopes: [...], count }, meta }
 */
function extractCorrId(responseData, executionId) {
  // Prefer explicit correlationId in the response wrapper
  if (responseData?.data?.correlationId) return responseData.data.correlationId
  // Fall back: derive from envelope corr fields
  const list =
    responseData?.data?.envelopes ||
    responseData?.data ||
    []
  for (const env of list) {
    if (env?.corr) return env.corr
  }
  // Last resort: executionId is sometimes used as corr in simple setups
  return executionId
}

/**
 * Resolve the array of envelopes from the replay response.
 */
function extractEnvelopes(responseData) {
  if (Array.isArray(responseData?.data?.envelopes)) return responseData.data.envelopes
  if (Array.isArray(responseData?.data))             return responseData.data
  if (Array.isArray(responseData))                   return responseData
  return []
}

/**
 * Apply a single envelope to the node-status Map.
 * Returns a new Map (immutable update so React sees a reference change).
 * Returns the same Map if nothing changed.
 */
function applyNodeEnvelope(map, envelope) {
  const nodeId = envelope?.payload?.nodeId
  if (!nodeId) return map

  const newStatus = INTENT_TO_STATUS[envelope.intent]
  if (!newStatus) return map

  // Only update if the status actually changes (avoid spurious re-renders)
  if (map.get(nodeId) === newStatus) return map

  const next = new Map(map)
  next.set(nodeId, newStatus)
  return next
}

/**
 * Apply a batch of envelopes (replay path) in chronological order.
 * The last status wins for each node.
 */
function applyEnvelopeBatch(envelopes) {
  let map = new Map()
  for (const env of envelopes) {
    map = applyNodeEnvelope(map, env)
  }
  return map
}

/**
 * Determine workflow-level run status from a batch of envelopes.
 */
function resolveRunStatusFromBatch(envelopes) {
  let runStatus = null
  for (const env of envelopes) {
    if (env.intent === INTENT.FLOW_COMPLETED) runStatus = 'completed'
    else if (env.intent === INTENT.FLOW_FAILED) runStatus = 'failed'
  }
  return runStatus
}

// ─── Collector WebSocket URL (matches useEventStream.js) ─────────────────────
const COLLECTOR_WS =
  typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
    : 'ws://localhost:9848'

const BASE_RECONNECT_DELAY = 1000
const MAX_RECONNECT_DELAY  = 30000

// ─── hook ────────────────────────────────────────────────────────────────────

export function useExecutionOverlay(executionId) {
  const [nodeStatus, setNodeStatus] = useState(() => new Map())
  const [runStatus,  setRunStatus]  = useState(null)
  const [error,      setError]      = useState(null)
  const [isReplay,   setIsReplay]   = useState(false)

  // Persist corr id discovered during replay so the live handler can filter
  const corrIdRef   = useRef(null)
  const mountedRef  = useRef(true)

  // ── cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // ── replay: fetch past envelopes ──────────────────────────────────────────
  useEffect(() => {
    if (!executionId) return

    let cancelled = false

    async function replay() {
      try {
        // QF-MT WP8: relative, nginx-proxied path with credentials — matches
        // WorkflowDots.jsx:46. The old direct `${hostname}:3200` call sent no
        // credentials, so it 401s once quoxflow enforces JWT org scoping.
        const res = await fetch(`/quoxflow/api/executions/${executionId}/envelopes`, {
          credentials: 'include',
        })
        if (cancelled || !mountedRef.current) return

        if (!res.ok) {
          setError(`Envelope fetch failed: ${res.status}`)
          return
        }

        const data = await res.json()
        if (cancelled || !mountedRef.current) return

        const envelopes = extractEnvelopes(data)
        corrIdRef.current = extractCorrId(data, executionId)

        const map = applyEnvelopeBatch(envelopes)
        const wfStatus = resolveRunStatusFromBatch(envelopes)

        setNodeStatus(map)
        if (wfStatus) setRunStatus(wfStatus)
        setIsReplay(true)
        setError(null)
      } catch (err) {
        if (cancelled || !mountedRef.current) return
        // Non-fatal — live stream can still work without replay
        console.warn('[useExecutionOverlay] replay fetch failed:', err.message)
        setError(err.message)
        // Set corrId to executionId as fallback so live stream still filters
        if (!corrIdRef.current) corrIdRef.current = executionId
      }
    }

    // Reset state when executionId changes
    setNodeStatus(new Map())
    setRunStatus(null)
    setIsReplay(false)
    setError(null)
    corrIdRef.current = null

    replay()
    return () => { cancelled = true }
  }, [executionId])

  // ── live: inline WebSocket subscription (only when executionId is set) ───
  // We manage the WS directly here instead of delegating to useEventStream so
  // we can gate the connection on executionId without violating hook call rules.
  useEffect(() => {
    if (!executionId) return  // no-op: keeps WS count at 0 for null/undefined

    let ws = null
    let reconnectTimer = null
    let reconnectDelay = BASE_RECONNECT_DELAY

    function handleEnvelope(envelope) {
      if (!mountedRef.current) return

      const intent    = envelope?.intent || ''
      const envCorr   = envelope?.corr
      const envExecId = envelope?.payload?.executionId

      // Filter: corr id match OR executionId in payload
      const corrMatch = corrIdRef.current && envCorr === corrIdRef.current
      const execMatch = envExecId === executionId
      if (!corrMatch && !execMatch) return

      // Node-level envelope
      if (INTENT_TO_STATUS[intent]) {
        setNodeStatus(prev => applyNodeEnvelope(prev, envelope))
        return
      }

      // Workflow-level envelope
      if (intent === INTENT.FLOW_COMPLETED) { setRunStatus('completed'); return }
      if (intent === INTENT.FLOW_FAILED)    { setRunStatus('failed');    return }
    }

    function connect() {
      if (!mountedRef.current) return
      ws = new WebSocket(`${COLLECTOR_WS}/api/v1/stream/events`)

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          handleEnvelope(data)
        } catch { /* ignore malformed */ }
      }

      ws.onclose = () => {
        if (!mountedRef.current) return
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
          connect()
        }, reconnectDelay)
      }
    }

    connect()

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (ws) ws.close()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionId])

  return { nodeStatus, runStatus, error, isReplay }
}

export default useExecutionOverlay
