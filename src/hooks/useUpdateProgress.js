/**
 * useUpdateProgress — SSE hook for real-time update progress.
 * Connects to the update-progress SSE endpoint when an update is active.
 *
 * Returns: { connected, steps, currentStep, status, error, message }
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useWorkspace } from '../contexts/WorkspaceContext'

export function useUpdateProgress(active = false) {
    const { currentOrg } = useWorkspace()
    const [connected, setConnected] = useState(false)
    const [steps, setSteps] = useState([])
    const [currentStep, setCurrentStep] = useState(null)
    const [status, setStatus] = useState(null)
    const [error, setError] = useState(null)
    const [message, setMessage] = useState(null)
    const [durationMs, setDurationMs] = useState(null)
    const eventSourceRef = useRef(null)

    const disconnect = useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close()
            eventSourceRef.current = null
        }
        setConnected(false)
    }, [])

    useEffect(() => {
        if (!active || !currentOrg?.id) {
            disconnect()
            return
        }

        const url = `/api/orgs/${currentOrg.id}/update-progress`
        const es = new EventSource(url, { withCredentials: true })
        eventSourceRef.current = es

        es.onopen = () => {
            setConnected(true)
            setError(null)
        }

        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data)

                if (data.steps) {
                    setSteps(data.steps)
                }
                if (data.step) {
                    setCurrentStep(data.step)
                }
                if (data.message) {
                    setMessage(data.message)
                }
                if (data.status) {
                    setStatus(data.status)
                }
                if (data.error) {
                    setError(data.error)
                }
                if (data.duration_ms) {
                    setDurationMs(data.duration_ms)
                }

                // Auto-disconnect on terminal states
                if (data.status === 'completed' || data.status === 'failed') {
                    // Keep connection for a moment to ensure final events are received
                    setTimeout(() => disconnect(), 2000)
                }
            } catch {
                // Ignore malformed SSE data
            }
        }

        es.onerror = () => {
            setConnected(false)
            // EventSource will auto-reconnect
        }

        return () => disconnect()
    }, [active, currentOrg?.id, disconnect])

    return {
        connected,
        steps,
        currentStep,
        status,
        error,
        message,
        durationMs,
        disconnect
    }
}

export default useUpdateProgress
