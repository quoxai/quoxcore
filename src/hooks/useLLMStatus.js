/**
 * useLLMStatus — Polls /chat/status to detect LLM auth issues early
 *
 * Returns { ready, authMethod, recommendation, loading, error }
 * Polls every 60s. Components can show warnings before users waste time.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { getCollectorUnavailableStatus, getSessionExpiredStatus, normalizeLlmStatusPayload } from '../services/llmStatus'

const POLL_INTERVAL_MS = 60000
const FETCH_TIMEOUT_MS = 10000
// A single probe failure (timeout blip, transient network error) must not
// latch the global degraded banner. Only two consecutive failures with no
// known-healthy status confirm the collector is actually unavailable.
const CONSECUTIVE_FAILS_TO_LATCH = 2

export default function useLLMStatus() {
  const [status, setStatus] = useState({ ready: null, authMethod: null, recommendation: null, loading: true, error: null })
  const timerRef = useRef(null)
  const mountedRef = useRef(true)
  const lastHealthyStatusRef = useRef(null)
  const consecutiveFailsRef = useRef(0)

  const check = useCallback(async () => {
    try {
      const resp = await fetch('/collector/chat/status', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (resp.status === 401 || resp.status === 403) {
        // Stale session, not a dead collector — don't mislabel it.
        if (mountedRef.current) {
          consecutiveFailsRef.current = 0
          setStatus(getSessionExpiredStatus(`HTTP ${resp.status}`))
        }
        return
      }
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`)
      }
      const data = await resp.json()
      if (mountedRef.current) {
        consecutiveFailsRef.current = 0
        const normalized = normalizeLlmStatusPayload(data)
        if (normalized.ready) {
          lastHealthyStatusRef.current = normalized
        }
        setStatus(normalized)
      }
    } catch (err) {
      if (!mountedRef.current) return
      consecutiveFailsRef.current += 1
      if (lastHealthyStatusRef.current?.ready) {
        setStatus({
          ...lastHealthyStatusRef.current,
          loading: false,
          error: err.message,
          debug: {
            ...(lastHealthyStatusRef.current.debug || {}),
            staleStatusCheckError: err.message,
          },
        })
        return
      }
      if (consecutiveFailsRef.current < CONSECUTIVE_FAILS_TO_LATCH) {
        // Single blip with no known-healthy baseline yet — don't latch the
        // degraded banner on one failure. Wait for a confirming failure.
        return
      }
      setStatus(getCollectorUnavailableStatus(err.message))
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    check()
    timerRef.current = setInterval(check, POLL_INTERVAL_MS)
    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        check()
      }
    }
    window.addEventListener('focus', handleVisibilityOrFocus)
    document.addEventListener('visibilitychange', handleVisibilityOrFocus)
    return () => {
      mountedRef.current = false
      clearInterval(timerRef.current)
      window.removeEventListener('focus', handleVisibilityOrFocus)
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus)
    }
  }, [check])

  return status
}
