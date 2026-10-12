/**
 * ErrorBoundary - Global Error Handler
 *
 * Catches uncaught JavaScript errors anywhere in the component tree
 * and displays a user-friendly fallback UI instead of a white screen.
 *
 * Usage: Wrap the root App component in main.jsx
 */

import { Component } from 'react'
import { reportErrorDirect } from '../services/errorCaptureService'

class ErrorBoundary extends Component {
    constructor(props) {
        super(props)
        this.state = {
            hasError: false,
            error: null,
            errorInfo: null,
            reportStatus: 'idle', // idle | sending | sent | failed
        }
    }

    static getDerivedStateFromError(error) {
        // Update state so next render shows fallback UI
        return { hasError: true, error }
    }

    componentDidCatch(error, errorInfo) {
        // Log error for debugging
        console.error('[ErrorBoundary] Uncaught error:', error)
        console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack)

        this.setState({ errorInfo })

        // Optional: Send to error tracking service
        // e.g., Sentry, LogRocket, etc.
        if (typeof window !== 'undefined' && window.reportError) {
            window.reportError({
                error: error.toString(),
                stack: error.stack,
                componentStack: errorInfo.componentStack,
                url: window.location.href,
                timestamp: new Date().toISOString(),
            })
        }
    }

    handleRetry = () => {
        // Clear error state and attempt to re-render
        this.setState({
            hasError: false,
            error: null,
            errorInfo: null,
        })
    }

    handleReload = () => {
        window.location.reload()
    }

    handleReport = async () => {
        this.setState({ reportStatus: 'sending' })
        try {
            await reportErrorDirect({
                error_type: 'react_error_boundary',
                message: this.state.error?.toString() || 'Unknown error',
                stack: this.state.error?.stack || '',
                component_stack: this.state.errorInfo?.componentStack || '',
                url: window.location.href,
                context: 'ErrorBoundary crash screen'
            })
            this.setState({ reportStatus: 'sent' })
        } catch {
            this.setState({ reportStatus: 'failed' })
        }
    }

    render() {
        if (this.state.hasError) {
            // Scoped mode: a `fallback` render prop keeps the crash CONTAINED to
            // this subtree instead of taking over the whole viewport. Used to
            // quarantine plugin-contributed UI (a bad third-party plugin must
            // never blank a host page). Called with { error, retry }.
            if (this.props.fallback) {
                return this.props.fallback({ error: this.state.error, retry: this.handleRetry });
            }
            return (
                <div style={styles.container}>
                    <div style={styles.content}>
                        {/* HAL-inspired error indicator */}
                        <div style={styles.halEye}>
                            <div style={styles.halEyeInner} />
                        </div>

                        <h1 style={styles.title}>Something went wrong</h1>
                        <p style={styles.message}>
                            I'm sorry, but I can't do that right now. An unexpected error has occurred.
                        </p>

                        {/* Error details (collapsible in production) */}
                        {this.state.error && (
                            <details style={styles.details}>
                                <summary style={styles.summary}>Technical Details</summary>
                                <pre style={styles.errorText}>
                                    {this.state.error.toString()}
                                    {this.state.error.stack && (
                                        <>
                                            {'\n\nStack trace:\n'}
                                            {this.state.error.stack}
                                        </>
                                    )}
                                </pre>
                            </details>
                        )}

                        {/* Action buttons */}
                        <div style={styles.actions}>
                            <button
                                style={styles.retryButton}
                                onClick={this.handleRetry}
                            >
                                Try Again
                            </button>
                            <button
                                style={styles.reloadButton}
                                onClick={this.handleReload}
                            >
                                Reload Page
                            </button>
                            {this.state.reportStatus === 'sent' ? (
                                <button style={{ ...styles.reloadButton, color: '#22c55e', borderColor: 'rgba(34, 197, 94, 0.3)' }} disabled>
                                    Report Sent
                                </button>
                            ) : (
                                <button
                                    style={{ ...styles.reloadButton, color: '#38bdf8', borderColor: 'rgba(56, 189, 248, 0.3)' }}
                                    onClick={this.handleReport}
                                    disabled={this.state.reportStatus === 'sending'}
                                >
                                    {this.state.reportStatus === 'sending' ? 'Sending...' :
                                     this.state.reportStatus === 'failed' ? 'Retry Report' : 'Report Error'}
                                </button>
                            )}
                        </div>

                        <p style={styles.hint}>
                            {this.state.reportStatus === 'sent'
                                ? 'Error report submitted. Thank you for helping improve QuoxCORE.'
                                : 'If this problem persists, use "Report Error" to help us investigate.'}
                        </p>
                    </div>
                </div>
            )
        }

        return this.props.children
    }
}

// Inline styles to ensure they work even if CSS fails to load
const styles = {
    container: {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(9, 11, 20, 0.92)',
        backdropFilter: 'var(--glass-blur)',
        WebkitBackdropFilter: 'var(--glass-blur)',
        color: '#f4f4f5',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        padding: '20px',
        zIndex: 9999,
    },
    content: {
        maxWidth: '500px',
        textAlign: 'center',
        animation: 'fadeIn 0.3s ease-out',
    },
    halEye: {
        width: '80px',
        height: '80px',
        margin: '0 auto 24px',
        borderRadius: '50%',
        background: 'radial-gradient(circle, #38bdf8 0%, #1e3a5f 70%, #1a1a1a 100%)',
        boxShadow: '0 0 30px rgba(56, 189, 248, 0.5), 0 0 60px rgba(56, 189, 248, 0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'pulse 2s ease-in-out infinite',
    },
    halEyeInner: {
        width: '30px',
        height: '30px',
        borderRadius: '50%',
        backgroundColor: '#fff',
        opacity: 0.3,
    },
    title: {
        fontSize: '24px',
        fontWeight: 600,
        marginBottom: '12px',
        color: '#f4f4f5',
    },
    message: {
        fontSize: '15px',
        color: '#a1a1aa',
        marginBottom: '24px',
        lineHeight: 1.6,
    },
    details: {
        marginBottom: '24px',
        textAlign: 'left',
        backgroundColor: 'rgba(255, 255, 255, 0.04)',
        borderRadius: '8px',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        overflow: 'hidden',
    },
    summary: {
        padding: '12px 16px',
        cursor: 'pointer',
        fontSize: '13px',
        color: '#a1a1aa',
        backgroundColor: 'rgba(255, 255, 255, 0.05)',
        userSelect: 'none',
    },
    errorText: {
        margin: 0,
        padding: '16px',
        fontSize: '12px',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        color: '#f87171',
        overflow: 'auto',
        maxHeight: '200px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
    },
    actions: {
        display: 'flex',
        gap: '12px',
        justifyContent: 'center',
        marginBottom: '24px',
    },
    retryButton: {
        padding: '10px 24px',
        fontSize: '14px',
        fontWeight: 600,
        color: '#0a0a0a',
        backgroundColor: '#ffbf69',
        border: 'none',
        borderRadius: '6px',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
    },
    reloadButton: {
        padding: '10px 24px',
        fontSize: '14px',
        fontWeight: 500,
        color: '#f4f4f5',
        backgroundColor: 'rgba(255, 255, 255, 0.05)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: '6px',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
    },
    hint: {
        fontSize: '12px',
        color: '#71717a',
    },
}

// Add CSS animations via style injection (fallback)
if (typeof document !== 'undefined') {
    const styleSheet = document.createElement('style')
    styleSheet.textContent = `
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; box-shadow: 0 0 30px rgba(56, 189, 248, 0.5), 0 0 60px rgba(56, 189, 248, 0.3); }
            50% { opacity: 0.8; box-shadow: 0 0 40px rgba(56, 189, 248, 0.6), 0 0 80px rgba(56, 189, 248, 0.4); }
        }
    `
    document.head.appendChild(styleSheet)
}

export default ErrorBoundary
