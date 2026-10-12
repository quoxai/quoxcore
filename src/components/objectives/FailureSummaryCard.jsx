/**
 * FailureSummaryCard — Partial failure summary with batch retry
 *
 * Shows "3 of 8 tasks failed. 2 retryable." with a Retry All Failed button.
 * Renders nothing when no tasks have failed.
 *
 * Props:
 *   tasks      — array of task objects with status field
 *   onRetryAll — callback to retry all failed tasks
 */

export default function FailureSummaryCard({ tasks, onRetryAll }) {
  if (!tasks || tasks.length === 0) return null

  const total = tasks.length
  const failed = tasks.filter(t => t.status === 'failed').length
  const skipped = tasks.filter(t => t.status === 'skipped').length
  const completed = tasks.filter(t => t.status === 'completed').length

  if (failed === 0) return null

  return (
    <div style={{
      padding: '8px 12px',
      borderRadius: 'var(--m-radius-md, 6px)',
      background: 'rgba(248,113,113,0.04)',
      border: '1px solid rgba(248,113,113,0.12)',
      marginBottom: 12,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 12,
    }}>
      <span style={{ color: '#f87171', fontWeight: 600 }}>
        {failed} of {total} tasks failed
      </span>
      {skipped > 0 && (
        <span style={{ color: 'var(--m-text-tertiary, #71717a)' }}>
          · {skipped} skipped
        </span>
      )}
      {completed > 0 && (
        <span style={{ color: 'var(--m-success, #4ade80)' }}>
          · {completed} completed
        </span>
      )}
      <button
        onClick={onRetryAll}
        style={{
          marginLeft: 'auto',
          padding: '3px 10px', borderRadius: 4, fontSize: 11, fontWeight: 500,
          background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
          color: '#60a5fa', cursor: 'pointer', flexShrink: 0,
        }}
      >
        Retry All Failed
      </button>
    </div>
  )
}
