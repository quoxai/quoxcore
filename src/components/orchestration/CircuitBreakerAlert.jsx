/**
 * CircuitBreakerAlert — Red warning card for circuit breaker activation
 *
 * Appears at the top of objective detail when circuit breaker fires.
 * Also rendered in InboxItemDetailView for circuit_breaker_triggered items.
 *
 * @param {string} objectiveTitle
 * @param {string} teamName
 * @param {number} consecutiveFailures
 * @param {Array} failedTasks — [{ title, agentId, error }]
 * @param {Function} [onResume] — resume with adjusted parameters
 * @param {Function} [onPause] — pause indefinitely
 * @param {Function} [onSwitchTeam] — try a different team
 */

export default function CircuitBreakerAlert({
  objectiveTitle,
  teamName,
  consecutiveFailures = 3,
  failedTasks = [],
  onResume,
  onPause,
  onSwitchTeam,
}) {
  return (
    <div style={{
      width: '100%',
      background: 'rgba(239,68,68,0.04)',
      border: '1px solid rgba(239,68,68,0.2)',
      borderRadius: 6,
      padding: 14,
      position: 'relative',
      overflow: 'hidden',
      marginBottom: 12,
    }}>
      {/* Background glow */}
      <div style={{
        position: 'absolute', top: -40, right: -40,
        width: 120, height: 120, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(239,68,68,0.08) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
      }}>
        <span style={{ fontSize: 16, lineHeight: 1 }}>{'\u26A1'}</span>
        <span style={{
          fontSize: 13, fontWeight: 700, color: '#ef4444',
          textTransform: 'uppercase', letterSpacing: 0.5,
        }}>
          Circuit Breaker Activated
        </span>
      </div>

      {/* Description */}
      <p style={{
        fontSize: 12, color: 'rgba(255,255,255,0.6)', margin: '0 0 10px',
        lineHeight: 1.5,
      }}>
        {consecutiveFailures} consecutive failures in
        {objectiveTitle ? ` "${objectiveTitle}"` : ' this objective'}
        {teamName ? ` (${teamName})` : ''}. Execution paused.
      </p>

      {/* Failed task list */}
      {failedTasks.length > 0 && (
        <div style={{
          padding: '8px 10px', borderRadius: 4,
          background: 'rgba(0,0,0,0.2)',
          marginBottom: 12,
          fontFamily: 'var(--m-font-mono, monospace)',
          fontSize: 10, lineHeight: 1.6,
          color: 'rgba(255,255,255,0.5)',
          maxHeight: 80, overflowY: 'auto',
        }}>
          {failedTasks.map((t, i) => (
            <div key={i}>
              <span style={{ color: '#f87171' }}>{t.agentId}</span>
              {': '}{t.title}
              {t.error && <span style={{ color: 'rgba(255,255,255,0.3)' }}> — {t.error}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        {onResume && (
          <button onClick={onResume} style={{
            padding: '5px 12px', borderRadius: 4, fontSize: 11, fontWeight: 500,
            background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)',
            color: '#60a5fa', cursor: 'pointer',
          }}>
            Resume (adjusted)
          </button>
        )}
        {onPause && (
          <button onClick={onPause} style={{
            padding: '5px 12px', borderRadius: 4, fontSize: 11, fontWeight: 500,
            background: 'transparent', border: '1px solid rgba(255,255,255,0.08)',
            color: 'var(--m-text-tertiary, #71717a)', cursor: 'pointer',
          }}>
            Pause indefinitely
          </button>
        )}
        {onSwitchTeam && (
          <button onClick={onSwitchTeam} style={{
            padding: '5px 12px', borderRadius: 4, fontSize: 11, fontWeight: 500,
            background: 'transparent', border: '1px solid rgba(245,158,11,0.2)',
            color: '#f59e0b', cursor: 'pointer',
          }}>
            Switch team
          </button>
        )}
      </div>
    </div>
  )
}
