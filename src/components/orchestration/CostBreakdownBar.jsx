/**
 * CostBreakdownBar — Horizontal stacked bar showing token spend per agent
 *
 * Hover segments for tooltip. Over-budget shown with red overflow.
 *
 * @param {Array} segments — [{ agentId, agentName, color, tokens, costUsd }]
 * @param {number} [totalBudget] — max tokens for scale
 * @param {number} [height] — bar height (default 24)
 */

export default function CostBreakdownBar({ segments = [], totalBudget, height = 24 }) {
  if (segments.length === 0) return null

  const totalUsed = segments.reduce((sum, s) => sum + (s.tokens || 0), 0)
  const max = totalBudget || totalUsed || 1
  const overBudget = totalBudget && totalUsed > totalBudget

  return (
    <div style={{ width: '100%' }}>
      <div style={{
        width: '100%',
        height,
        borderRadius: 4,
        overflow: 'hidden',
        display: 'flex',
        background: 'rgba(255,255,255,0.04)',
        position: 'relative',
      }}>
        {segments.map((seg, i) => {
          const widthPct = (seg.tokens / max) * 100
          const tooltip = `${seg.agentName || seg.agentId}: ${seg.tokens.toLocaleString()} tokens${seg.costUsd != null ? ` ($${seg.costUsd.toFixed(3)})` : ''}`

          return (
            <div
              key={seg.agentId || i}
              title={tooltip}
              style={{
                width: `${Math.max(widthPct, 0.5)}%`,
                height: '100%',
                background: seg.color || '#3b82f6',
                opacity: 0.75,
                cursor: 'help',
                transition: 'opacity 0.15s',
                borderRight: i < segments.length - 1 ? '1px solid rgba(0,0,0,0.3)' : 'none',
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = '1'}
              onMouseLeave={e => e.currentTarget.style.opacity = '0.75'}
            />
          )
        })}

        {/* Over-budget indicator */}
        {overBudget && (
          <div style={{
            position: 'absolute', right: 0, top: 0, bottom: 0, width: 4,
            background: 'repeating-linear-gradient(45deg, #ef4444 0, #ef4444 2px, transparent 2px, transparent 4px)',
          }} />
        )}
      </div>

      {/* Total label */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', marginTop: 3,
        fontSize: 9, fontFamily: 'var(--m-font-mono, monospace)',
        fontVariantNumeric: 'tabular-nums',
      }}>
        <span style={{ color: 'rgba(255,255,255,0.4)' }}>
          {totalUsed.toLocaleString()} tokens
        </span>
        {totalBudget && (
          <span style={{ color: overBudget ? '#ef4444' : 'rgba(255,255,255,0.3)' }}>
            / {totalBudget.toLocaleString()}
          </span>
        )}
      </div>
    </div>
  )
}
