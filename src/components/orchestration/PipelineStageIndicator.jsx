/**
 * PipelineStageIndicator — Horizontal progress bar divided into named stages
 *
 * Each stage shows status (completed/active/pending/failed) with connecting arrows.
 * Active stage pulses subtly.
 *
 * @param {Array} stages — [{ name, status, taskCount, completedCount }]
 * @param {boolean} compact — hide task counts (default false)
 */

const STATUS_STYLES = {
  completed: { bg: 'rgba(16,185,129,0.15)', border: 'rgba(16,185,129,0.3)', color: '#10b981', icon: '\u2713' },
  active:    { bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.3)', color: '#3b82f6', icon: '\u25c9' },
  pending:   { bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.4)', icon: '\u25cb' },
  failed:    { bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.25)', color: '#ef4444', icon: '\u2717' },
}

export default function PipelineStageIndicator({ stages = [], compact = false }) {
  if (stages.length === 0) return null

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 0,
      width: '100%',
      padding: compact ? '4px 0' : '8px 0',
    }}>
      {stages.map((stage, i) => {
        const s = STATUS_STYLES[stage.status] || STATUS_STYLES.pending
        const isActive = stage.status === 'active'

        return (
          <div key={stage.name} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            {/* Stage pill */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              flex: 1,
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: compact ? '3px 8px' : '5px 12px',
                borderRadius: 16,
                background: s.bg,
                border: `1px solid ${s.border}`,
                fontSize: compact ? 10 : 11,
                fontWeight: 500,
                color: s.color,
                whiteSpace: 'nowrap',
                animation: isActive ? 'pipelinePulse 2s ease-in-out infinite' : undefined,
              }}>
                <span style={{ fontSize: compact ? 9 : 11 }}>{s.icon}</span>
                {stage.name}
              </div>
              {!compact && stage.taskCount > 0 && (
                <span style={{
                  fontSize: 9, color: 'rgba(255,255,255,0.4)',
                  fontFamily: 'var(--m-font-mono, monospace)',
                  fontVariantNumeric: 'tabular-nums',
                  marginTop: 3,
                }}>
                  {stage.completedCount || 0}/{stage.taskCount}
                </span>
              )}
            </div>

            {/* Arrow connector */}
            {i < stages.length - 1 && (
              <span style={{
                color: 'rgba(255,255,255,0.15)',
                fontSize: 12,
                padding: '0 2px',
                flexShrink: 0,
              }}>
                {'\u25b8'}
              </span>
            )}
          </div>
        )
      })}

      <style>{`
        @keyframes pipelinePulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
      `}</style>
    </div>
  )
}
