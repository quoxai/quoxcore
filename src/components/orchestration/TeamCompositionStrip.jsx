/**
 * TeamCompositionStrip — Horizontal overlapping agent avatar circles
 *
 * Orchestrator circle is slightly larger with gold border.
 * Hover any circle for agent name + success rate tooltip.
 * Overflow shown as "+N" badge.
 *
 * @param {Array} agents — [{ id, name, role, color, successRate }]
 * @param {number} maxVisible — max circles before "+N" (default 8)
 * @param {'sm'|'md'} size — circle size (default 'md')
 * @param {Function} [onAgentClick] — callback(agentId)
 */

const SIZE_MAP = { sm: 20, md: 28 }
const OVERLAP = -6

function getInitial(name) {
  return (name || '?')[0].toUpperCase()
}

function getRateColor(rate) {
  if (rate == null) return 'rgba(255,255,255,0.3)'
  if (rate >= 0.8) return '#10b981'
  if (rate >= 0.5) return '#f59e0b'
  return '#ef4444'
}

export default function TeamCompositionStrip({ agents = [], maxVisible = 8, size = 'md', onAgentClick }) {
  const circlePx = SIZE_MAP[size] || SIZE_MAP.md
  const visible = agents.slice(0, maxVisible)
  const overflow = agents.length - maxVisible

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      height: circlePx + 4,
    }}>
      {visible.map((agent, i) => {
        const isOrch = agent.role === 'orchestrator'
        const actualSize = isOrch ? circlePx + 4 : circlePx
        const borderColor = isOrch ? '#f59e0b' : (agent.color || 'rgba(255,255,255,0.2)')
        const tooltip = `${agent.name || agent.id}${agent.successRate != null ? ` — ${Math.round(agent.successRate * 100)}%` : ''}`

        return (
          <div
            key={agent.id}
            title={tooltip}
            onClick={onAgentClick ? () => onAgentClick(agent.id) : undefined}
            style={{
              width: actualSize,
              height: actualSize,
              borderRadius: '50%',
              border: `2px solid ${borderColor}`,
              background: 'var(--m-bg-base, rgba(255,255,255,0.04))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: actualSize * 0.38,
              fontWeight: 600,
              color: 'rgba(255,255,255,0.7)',
              marginLeft: i > 0 ? OVERLAP : 0,
              cursor: onAgentClick ? 'pointer' : 'default',
              position: 'relative',
              zIndex: visible.length - i,
              transition: 'transform 0.15s',
              flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.15)'; e.currentTarget.style.zIndex = 100 }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.zIndex = visible.length - i }}
          >
            {getInitial(agent.name || agent.id)}
          </div>
        )
      })}

      {overflow > 0 && (
        <div style={{
          width: circlePx,
          height: circlePx,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 9,
          fontWeight: 600,
          color: 'rgba(255,255,255,0.5)',
          marginLeft: OVERLAP,
          fontFamily: 'var(--m-font-mono, monospace)',
        }}>
          +{overflow}
        </div>
      )}
    </div>
  )
}
