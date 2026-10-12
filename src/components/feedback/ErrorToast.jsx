/**
 * ErrorToast - Shows toast notifications when errors are captured
 * Provides "Report" and "Dismiss" actions for each error
 */

import { useState, useEffect, useCallback } from 'react'
import { onErrorCaptured, dismissError, reportError } from '../../services/errorCaptureService'
import './feedback.css'

const MAX_VISIBLE = 3
const AUTO_DISMISS_MS = 15000

export default function ErrorToast() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    const unsub = onErrorCaptured((entry) => {
      setToasts(prev => {
        const next = [...prev, { ...entry, showReport: false, reportSent: false, description: '' }]
        return next.slice(-MAX_VISIBLE)
      })
    })
    return unsub
  }, [])

  // Auto-dismiss after timeout
  useEffect(() => {
    if (toasts.length === 0) return
    const timer = setTimeout(() => {
      setToasts(prev => prev.slice(1))
    }, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toasts.length])

  const handleDismiss = useCallback((id) => {
    dismissError(id)
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const toggleReport = useCallback((id) => {
    setToasts(prev => prev.map(t =>
      t.id === id ? { ...t, showReport: !t.showReport } : t
    ))
  }, [])

  const handleSendReport = useCallback(async (id) => {
    const toast = toasts.find(t => t.id === id)
    if (!toast) return
    try {
      await reportError(id, toast.description)
      setToasts(prev => prev.map(t =>
        t.id === id ? { ...t, reportSent: true, showReport: false } : t
      ))
      // Auto-dismiss after successful report
      setTimeout(() => handleDismiss(id), 2000)
    } catch {
      // Keep toast visible on failure
    }
  }, [toasts, handleDismiss])

  const updateDescription = useCallback((id, desc) => {
    setToasts(prev => prev.map(t =>
      t.id === id ? { ...t, description: desc } : t
    ))
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="qx-toast-stack">
      {toasts.map(toast => (
        <div key={toast.id} className="qx-toast qx-toast--error">
          <svg className="qx-toast__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div className="qx-toast__body">
            <div className="qx-toast__title">{toast.error_type?.replace(/_/g, ' ') || 'Error'}</div>
            <div className="qx-toast__msg" title={toast.message}>{toast.message}</div>
            {toast.reportSent ? (
              <div className="error-report-sent">Report sent. Thank you.</div>
            ) : (
              <>
                <div className="error-toast-actions">
                  <button className="error-toast-btn error-toast-btn-report" onClick={() => toggleReport(toast.id)}>
                    {toast.showReport ? 'Cancel' : 'Report'}
                  </button>
                  <button className="error-toast-btn" onClick={() => handleDismiss(toast.id)}>Dismiss</button>
                </div>
                {toast.showReport && (
                  <div className="error-report-inline">
                    <input
                      type="text"
                      placeholder="What were you doing? (optional)"
                      value={toast.description}
                      onChange={(e) => updateDescription(toast.id, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSendReport(toast.id) }}
                    />
                    <button onClick={() => handleSendReport(toast.id)}>Send</button>
                  </div>
                )}
              </>
            )}
          </div>
          <button className="qx-toast__close" onClick={() => handleDismiss(toast.id)} aria-label="Dismiss">&times;</button>
        </div>
      ))}
    </div>
  )
}
