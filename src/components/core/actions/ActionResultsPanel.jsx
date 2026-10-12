/**
 * ActionResultsPanel - Displays action execution history and results
 *
 * Shows:
 * - Current action with streaming progress and thinking steps
 * - History of recent actions (last 10)
 * - Expandable output for each action
 * - Copy-to-clipboard functionality
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import './actions.css'

const STATUS_ICONS = {
    running: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="action-status-icon action-status-icon--spin">
            <path d="M21 12a9 9 0 11-6.219-8.56"/>
        </svg>
    ),
    connected: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="action-status-icon action-status-icon--spin">
            <path d="M21 12a9 9 0 11-6.219-8.56"/>
        </svg>
    ),
    thinking: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="action-status-icon action-status-icon--pulse">
            <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
        </svg>
    ),
    streaming: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="action-status-icon action-status-icon--stream">
            <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>
        </svg>
    ),
    success: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="action-status-icon action-status-icon--success">
            <polyline points="20 6 9 17 4 12"/>
        </svg>
    ),
    error: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="action-status-icon action-status-icon--error">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
    ),
    cancelled: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="action-status-icon action-status-icon--cancelled">
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
    )
}

const STATUS_LABELS = {
    running: 'Starting...',
    connected: 'Connected',
    thinking: 'Processing...',
    streaming: 'Receiving...',
    success: 'Complete',
    error: 'Failed',
    cancelled: 'Cancelled'
}

function formatTime(timestamp) {
    const date = new Date(timestamp)
    return date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    })
}

function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

function CurrentActionDisplay({ action, onCancel }) {
    const outputRef = useRef(null)

    // Auto-scroll to bottom as content streams
    useEffect(() => {
        if (outputRef.current && action.streamedText) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight
        }
    }, [action.streamedText])

    const isActive = ['running', 'connected', 'thinking', 'streaming'].includes(action.status)
    const hasOutput = action.streamedText && action.streamedText.length > 0
    const hasThinking = action.thinkingSteps && action.thinkingSteps.length > 0

    return (
        <div className="current-action">
            <div className="current-action__header">
                <div className="current-action__status">
                    {STATUS_ICONS[action.status] || STATUS_ICONS.running}
                </div>
                <div className="current-action__info">
                    <span className="current-action__label">{action.label}</span>
                    <span className="current-action__state">{STATUS_LABELS[action.status] || action.status}</span>
                </div>
                {action.currentStep && (
                    <span className="current-action__step">{action.currentStep}</span>
                )}
                {isActive && onCancel && (
                    <button className="current-action__cancel" onClick={onCancel}>
                        Cancel
                    </button>
                )}
            </div>

            {/* Thinking Steps */}
            {hasThinking && (
                <div className="current-action__thinking">
                    {action.thinkingSteps.map((step, i) => (
                        <div key={i} className="thinking-step">
                            <span className="thinking-step__agent">{step.agent}</span>
                            <span className="thinking-step__message">{step.message}</span>
                        </div>
                    ))}
                </div>
            )}

            {/* Streaming Output */}
            {hasOutput && (
                <div className="current-action__output" ref={outputRef}>
                    <pre>{action.streamedText}</pre>
                </div>
            )}
        </div>
    )
}

function ActionItem({ action, expanded, onToggle }) {
    const [copied, setCopied] = useState(false)
    const outputRef = useRef(null)

    const handleCopy = useCallback(async (e) => {
        e.stopPropagation()
        if (action.result) {
            try {
                await navigator.clipboard.writeText(action.result)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
            } catch (err) {
                console.error('Failed to copy:', err)
            }
        }
    }, [action.result])

    const hasOutput = action.result && action.result.length > 0

    return (
        <div className={`action-item action-item--${action.status}`}>
            <div
                className="action-item__header"
                onClick={() => hasOutput && onToggle?.()}
                style={{ cursor: hasOutput ? 'pointer' : 'default' }}
            >
                <div className="action-item__status">
                    {STATUS_ICONS[action.status] || STATUS_ICONS.success}
                </div>
                <div className="action-item__info">
                    <span className="action-item__label">{action.label}</span>
                    {action.timestamp && (
                        <span className="action-item__time">{formatTime(action.timestamp)}</span>
                    )}
                </div>
                {action.duration && (
                    <span className="action-item__duration">{formatDuration(action.duration)}</span>
                )}
                {action.cost && (
                    <span className="action-item__cost">${action.cost.toFixed(4)}</span>
                )}
                {hasOutput && (
                    <span className={`action-item__expand ${expanded ? 'action-item__expand--open' : ''}`}>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="6 9 12 15 18 9"/>
                        </svg>
                    </span>
                )}
            </div>

            {expanded && hasOutput && (
                <div className="action-item__output">
                    <div className="action-item__output-header">
                        <span>Output ({action.result.length} chars)</span>
                        <button
                            className="action-item__copy"
                            onClick={handleCopy}
                            title={copied ? 'Copied!' : 'Copy to clipboard'}
                        >
                            {copied ? (
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="20 6 9 17 4 12"/>
                                </svg>
                            ) : (
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                                </svg>
                            )}
                            <span>{copied ? 'Copied' : 'Copy'}</span>
                        </button>
                    </div>
                    <pre className="action-item__result" ref={outputRef}>{action.result}</pre>
                </div>
            )}
        </div>
    )
}

export function ActionResultsPanel({
    currentAction,
    history = [],
    maxHistory = 10,
    onClearHistory,
    onCancelAction
}) {
    const [expandedId, setExpandedId] = useState(null)

    // Auto-expand latest completed action
    useEffect(() => {
        if (history.length > 0 && !currentAction) {
            const latest = history[0]
            if (latest.result && latest.result.length > 0) {
                setExpandedId(latest.id)
            }
        }
    }, [history, currentAction])

    const toggleExpand = (id) => {
        setExpandedId(expandedId === id ? null : id)
    }

    const displayHistory = history.slice(0, maxHistory)
    const hasContent = displayHistory.length > 0 || currentAction

    if (!hasContent) {
        return (
            <div className="action-results-panel action-results-panel--empty">
                <div className="action-results-panel__empty">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
                        <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
                    </svg>
                    <span>Run an action to see results</span>
                </div>
            </div>
        )
    }

    return (
        <div className="action-results-panel">
            <div className="action-results-panel__header">
                <span className="action-results-panel__title">Action Results</span>
                {displayHistory.length > 0 && (
                    <span className="action-results-panel__count">
                        {displayHistory.length} action{displayHistory.length !== 1 ? 's' : ''}
                    </span>
                )}
                {onClearHistory && displayHistory.length > 0 && !currentAction && (
                    <button
                        className="action-results-panel__clear"
                        onClick={onClearHistory}
                        title="Clear history"
                    >
                        Clear
                    </button>
                )}
            </div>

            <div className="action-results-panel__content">
                {/* Current running action with streaming display */}
                {currentAction && (
                    <CurrentActionDisplay
                        action={currentAction}
                        onCancel={onCancelAction}
                    />
                )}

                {/* History */}
                {displayHistory.length > 0 && (
                    <div className="action-results-panel__list">
                        {displayHistory.map((action) => (
                            <ActionItem
                                key={action.id}
                                action={action}
                                expanded={expandedId === action.id}
                                onToggle={() => toggleExpand(action.id)}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

export default ActionResultsPanel
