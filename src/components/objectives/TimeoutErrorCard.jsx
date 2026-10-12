/**
 * TimeoutErrorCard — Clear timeout failure explanation with actionable options
 *
 * Shows when a task fails due to timeout. Explains what happened,
 * offers retry with 2x timeout, skip, or cancel.
 *
 * Props:
 *   timeoutMs      — the timeout that was exceeded (ms)
 *   onRetryLonger  — callback to retry with doubled timeout
 *   onSkip         — callback to skip this task
 *   onCancel       — callback to cancel the objective
 */

export default function TimeoutErrorCard({ timeoutMs, onRetryLonger, onSkip, onCancel }) {
  const timeoutMin = Math.round((timeoutMs || 0) / 60000)
  const doubleMin = timeoutMin * 2

  return (
    <div style={{
      padding: '10px 12px',
      borderRadius: 'var(--m-radius-md, 6px)',
      background: 'rgba(248,113,113,0.06)',
      border: '1px solid rgba(248,113,113,0.15)',
      marginTop: 8,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: '#f87171',
        marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3,
      }}>
        Task Timed Out
      </div>
      <p style={{
        fontSize: 12, color: 'var(--m-text-secondary, #a1a1aa)',
        margin: '0 0 8px', lineHeight: 1.5,
      }}>
        This task exceeded the {timeoutMin} minute timeout. The agent may need more time for this operation,
        or the task may be stuck.
      </p>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={onRetryLonger}
          style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 500,
            background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
            color: '#60a5fa', cursor: 'pointer',
          }}
        >
          Retry ({doubleMin}min timeout)
        </button>
        <button
          onClick={onSkip}
          style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 500,
            background: 'transparent', border: '1px solid rgba(255,255,255,0.08)',
            color: 'var(--m-text-tertiary, #71717a)', cursor: 'pointer',
          }}
        >
          Skip
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 500,
            background: 'transparent', border: '1px solid rgba(248,113,113,0.15)',
            color: '#f87171', cursor: 'pointer',
          }}
        >
          Cancel Objective
        </button>
      </div>
    </div>
  )
}
