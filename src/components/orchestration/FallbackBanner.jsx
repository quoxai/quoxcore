/**
 * FallbackBanner — Amber notification banner for agent fallback events
 *
 * Appears in the task timeline when a task was rerouted to a fallback agent
 * after the original agent exhausted retries.
 *
 * @param {string} originalAgent — agent that failed
 * @param {string} fallbackAgent — agent that took over
 * @param {string} reason — failure reason
 * @param {number} retryCount — how many retries were attempted
 * @param {Function} [onDismiss] — callback to dismiss the banner
 */

import { useState } from 'react'

export default function FallbackBanner({ originalAgent, fallbackAgent, reason, retryCount, onDismiss }) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  const handleDismiss = () => {
    setDismissed(true)
    if (onDismiss) onDismiss()
  }

  return (
    <div style={{
      width: '100%',
      minHeight: 32,
      background: 'rgba(245,158,11,0.06)',
      borderLeft: '3px solid #f59e0b',
      display: 'flex',
      alignItems: 'center',
      paddingLeft: 12,
      paddingRight: 8,
      gap: 8,
      fontSize: 11,
      marginBottom: 4,
      borderRadius: '0 4px 4px 0',
    }}>
      <span style={{
        fontFamily: 'var(--m-font-mono, monospace)',
        color: '#f59e0b',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        fontSize: 9,
        flexShrink: 0,
      }}>
        Fallback
      </span>

      <span style={{ color: 'rgba(255,255,255,0.6)', flex: 1 }}>
        <span style={{ color: '#f87171', fontWeight: 500 }}>{originalAgent}</span>
        {' failed after '}
        {retryCount}
        {' retries '}
        <span style={{ color: 'rgba(255,255,255,0.3)' }}>{'\u2192'}</span>
        {' routed to '}
        <span style={{ color: '#10b981', fontWeight: 500 }}>{fallbackAgent}</span>
      </span>

      {onDismiss && (
        <button
          onClick={handleDismiss}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.3)', fontSize: 14, padding: '0 4px',
            lineHeight: 1, flexShrink: 0,
          }}
          title="Dismiss"
        >
          {'\u2715'}
        </button>
      )}
    </div>
  )
}
