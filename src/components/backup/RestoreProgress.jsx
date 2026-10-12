/**
 * Restore Progress Component
 * Real-time per-component progress via SSE during restore operations.
 */

import { useState, useEffect, useRef } from 'react'
import { formatBytes } from '../../services/backup/backupService'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'

function timeElapsed(startMs) {
    const s = Math.floor((Date.now() - startMs) / 1000)
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}m ${s % 60}s`
}

export function RestoreProgress({ restoreId, onComplete }) {
    const { authFetch } = useAuth()
    const { currentOrg } = useWorkspace()
    const [events, setEvents] = useState([])
    const [status, setStatus] = useState('connecting')
    const [totalComponents, setTotalComponents] = useState(0)
    const [completedComponents, setCompletedComponents] = useState(0)
    const [totalFiles, setTotalFiles] = useState(0)
    const [totalBytes, setTotalBytes] = useState(0)
    const [currentComponent, setCurrentComponent] = useState(null)
    const startTimeRef = useRef(Date.now())
    const [elapsed, setElapsed] = useState('0s')
    const eventSourceRef = useRef(null)

    // Timer for elapsed display
    useEffect(() => {
        const timer = setInterval(() => {
            setElapsed(timeElapsed(startTimeRef.current))
        }, 1000)
        return () => clearInterval(timer)
    }, [])

    // SSE connection
    useEffect(() => {
        if (!restoreId || !currentOrg?.id) return

        // Build SSE URL — need to use the auth service base URL
        const baseUrl = `/api/orgs/${currentOrg.id}/restore-operations/${restoreId}/progress`

        const es = new EventSource(baseUrl)
        eventSourceRef.current = es

        es.onmessage = (e) => {
            try {
                const event = JSON.parse(e.data)
                setEvents(prev => [...prev, event])

                switch (event.type) {
                    case 'started':
                        setStatus('running')
                        setTotalComponents(event.totalComponents || 0)
                        break
                    case 'extracting':
                        setStatus('extracting')
                        setCurrentComponent('Extracting archive...')
                        break
                    case 'component_start':
                        setCurrentComponent(event.name || event.component)
                        break
                    case 'component_done':
                        setCompletedComponents(prev => prev + 1)
                        setTotalFiles(prev => prev + (event.files || 0))
                        setTotalBytes(prev => prev + (event.bytes || 0))
                        setCurrentComponent(null)
                        break
                    case 'component_error':
                        setCompletedComponents(prev => prev + 1)
                        setCurrentComponent(null)
                        break
                    case 'complete':
                        setStatus(event.status || 'completed')
                        es.close()
                        if (onComplete) onComplete(event)
                        break
                }
            } catch {}
        }

        es.onerror = () => {
            // SSE will auto-reconnect, but if restore is done it won't reconnect
            if (status !== 'completed' && status !== 'failed') {
                setStatus('reconnecting')
            }
        }

        return () => {
            es.close()
        }
    }, [restoreId, currentOrg?.id])

    const progressPercent = totalComponents > 0
        ? Math.round((completedComponents / totalComponents) * 100)
        : 0

    const isComplete = status === 'completed' || status === 'completed_with_errors' || status === 'failed' || status === 'dry_run_complete'

    return (
        <div className="restore-live-progress">
            {/* Header */}
            <div className="restore-live-header">
                <div className="restore-live-title">
                    {!isComplete && <span className="backup-spinner" style={{ width: 14, height: 14 }} />}
                    <span>
                        {status === 'connecting' ? 'Connecting...' :
                         status === 'extracting' ? 'Extracting Archive...' :
                         status === 'running' ? 'Restoring...' :
                         status === 'completed' ? 'Restore Complete' :
                         status === 'completed_with_errors' ? 'Completed with Errors' :
                         status === 'failed' ? 'Restore Failed' :
                         status === 'dry_run_complete' ? 'Dry Run Complete' :
                         'Processing...'}
                    </span>
                </div>
                <span className="restore-live-elapsed">{elapsed}</span>
            </div>

            {/* Progress bar */}
            <div className="backup-progress-bar-container">
                <div
                    className="backup-progress-bar"
                    style={{
                        width: isComplete ? '100%' : `${progressPercent}%`,
                        background: status === 'failed' ? '#ef4444' :
                                    status === 'completed_with_errors' ? '#f59e0b' :
                                    'var(--accent-primary, #10b981)'
                    }}
                >
                    {!isComplete && <div className="backup-progress-bar-animated" />}
                </div>
            </div>

            {/* Stats row */}
            <div className="restore-live-stats">
                <span>{completedComponents}/{totalComponents} components</span>
                <span>{totalFiles} files</span>
                <span>{formatBytes(totalBytes)}</span>
            </div>

            {/* Per-component list */}
            <div className="restore-live-components">
                {events.filter(e => e.type === 'component_start' || e.type === 'component_done' || e.type === 'component_error').map((e, i) => {
                    const isDone = events.some(d => d.type === 'component_done' && d.component === e.component && events.indexOf(d) > events.indexOf(e))
                    const isError = events.some(d => d.type === 'component_error' && d.component === e.component)

                    if (e.type !== 'component_start') return null

                    return (
                        <div key={i} className={`restore-live-component ${isDone ? 'done' : isError ? 'error' : 'active'}`}>
                            <span className="restore-live-component-icon">
                                {isDone ? '\u2713' : isError ? '\u2715' : ''}
                            </span>
                            <span className="restore-live-component-name">{e.name || e.component}</span>
                            {isDone && (() => {
                                const doneEvent = events.find(d => d.type === 'component_done' && d.component === e.component)
                                return doneEvent ? (
                                    <span className="restore-live-component-detail">
                                        {doneEvent.files} files · {formatBytes(doneEvent.bytes || 0)}
                                    </span>
                                ) : null
                            })()}
                            {isError && (() => {
                                const errEvent = events.find(d => d.type === 'component_error' && d.component === e.component)
                                return errEvent ? (
                                    <span className="restore-live-component-error">{errEvent.error}</span>
                                ) : null
                            })()}
                            {!isDone && !isError && (
                                <span className="backup-spinner" style={{ width: 12, height: 12 }} />
                            )}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

export default RestoreProgress
