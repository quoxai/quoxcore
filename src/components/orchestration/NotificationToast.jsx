/**
 * NotificationToast — Event notification popup
 *
 * Auto-dismisses after duration (configurable). Sticky for errors.
 * Used for task completions, failures, circuit breakers.
 *
 * @param {string} type — 'success' | 'error' | 'warning' | 'info' | 'agent'
 * @param {string} title — main message
 * @param {string} [subtitle] — secondary detail
 * @param {number} [duration] — auto-dismiss ms (0 = sticky, default 4000)
 * @param {Function} [onDismiss] — callback when dismissed
 */

import { useState, useEffect } from 'react'

// Map component type prop to .qx-toast variant modifier
const TYPE_VARIANT = {
  success: 'qx-toast--success',
  error:   'qx-toast--error',
  warning: 'qx-toast--warn',
  info:    '',
  agent:   'qx-toast--purple',
}

const TYPE_ICON = {
  success: '✓',
  error:   '✕',
  warning: '⚠',
  info:    '●',
  agent:   '◈',
}

export default function NotificationToast({ type = 'info', title, subtitle, duration = 4000, onDismiss }) {
  const [visible, setVisible] = useState(true)
  const variant = TYPE_VARIANT[type] ?? ''
  const icon    = TYPE_ICON[type] ?? TYPE_ICON.info

  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        setVisible(false)
        if (onDismiss) onDismiss()
      }, duration)
      return () => clearTimeout(timer)
    }
  }, [duration, onDismiss])

  if (!visible) return null

  return (
    <div className={`qx-toast ${variant}`}>
      <svg className="qx-toast__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <text x="8" y="12" textAnchor="middle" fontSize="12" fill="currentColor">{icon}</text>
      </svg>
      <div className="qx-toast__body">
        <div className="qx-toast__title">{title}</div>
        {subtitle && <div className="qx-toast__msg">{subtitle}</div>}
      </div>
      {(duration === 0 || onDismiss) && (
        <button
          className="qx-toast__close"
          onClick={() => { setVisible(false); if (onDismiss) onDismiss() }}
          aria-label="Dismiss"
        >&times;</button>
      )}
    </div>
  )
}

/**
 * ToastContainer — Positioned container for stacking toasts
 * Uses .qx-toast-stack (top-right position by default).
 */
export function ToastContainer({ children }) {
  return (
    <div className="qx-toast-stack qx-toast-stack--top">
      {children}
    </div>
  )
}
