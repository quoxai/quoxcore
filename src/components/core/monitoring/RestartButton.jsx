/**
 * RestartButton — Two-step confirmation restart for Docker services
 *
 * Shows "Restart" button that changes to "Confirm Restart?" on click.
 * Auto-reverts after 3 seconds if not confirmed. Shows spinner during
 * restart and inline success/error feedback.
 *
 * Only renders for services where registry.restartable === true.
 */

import { useState, useRef, useCallback } from 'react'
import { useAuth } from '../../../contexts/AuthContext'

// States: idle → confirming → restarting → success|error → idle
const CONFIRM_TIMEOUT_MS = 3000
const FEEDBACK_TIMEOUT_MS = 2000

export function RestartButton({ containerName, serviceName }) {
  const { authFetch } = useAuth()
  const [state, setState] = useState('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const confirmTimer = useRef(null)
  const feedbackTimer = useRef(null)

  const clearTimers = useCallback(() => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
  }, [])

  const handleClick = useCallback(async () => {
    if (state === 'idle') {
      setState('confirming')
      confirmTimer.current = setTimeout(() => setState('idle'), CONFIRM_TIMEOUT_MS)
      return
    }

    if (state === 'confirming') {
      clearTimers()
      setState('restarting')

      try {
        const response = await authFetch(`/orchestrator/sibling/${containerName}/restart`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })

        if (response?.success === false) {
          throw new Error(response.error || 'Restart failed')
        }

        setState('success')
        feedbackTimer.current = setTimeout(() => setState('idle'), FEEDBACK_TIMEOUT_MS)
      } catch (err) {
        const msg = err?.message || 'Restart failed'
        setErrorMsg(msg.includes('Rate limit') ? 'Rate limited: wait 60s' : msg)
        setState('error')
        feedbackTimer.current = setTimeout(() => {
          setState('idle')
          setErrorMsg('')
        }, FEEDBACK_TIMEOUT_MS)
      }
    }
  }, [state, containerName, authFetch, clearTimers])

  const handleCancel = useCallback(() => {
    clearTimers()
    setState('idle')
  }, [clearTimers])

  if (state === 'restarting') {
    return (
      <span className="restart-btn restart-btn--restarting">
        <svg className="restart-btn__spinner" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        Restarting...
      </span>
    )
  }

  if (state === 'success') {
    return (
      <span className="restart-btn restart-btn--success">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Restarted
      </span>
    )
  }

  if (state === 'error') {
    return (
      <span className="restart-btn restart-btn--error" title={errorMsg}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M15 9l-6 6M9 9l6 6" />
        </svg>
        {errorMsg.length > 30 ? 'Failed' : errorMsg}
      </span>
    )
  }

  if (state === 'confirming') {
    return (
      <span className="restart-btn restart-btn--confirming">
        <button className="restart-btn__confirm" onClick={handleClick}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 4v6h6M23 20v-6h-6" />
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
          </svg>
          Confirm Restart?
        </button>
        <button className="restart-btn__cancel" onClick={handleCancel} title="Cancel">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </span>
    )
  }

  // idle state
  return (
    <button className="restart-btn restart-btn--idle" onClick={handleClick} title={`Restart ${serviceName}`}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M1 4v6h6M23 20v-6h-6" />
        <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
      </svg>
      Restart
    </button>
  )
}

export default RestartButton
