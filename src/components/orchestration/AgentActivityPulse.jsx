/**
 * AgentActivityPulse — 20-bar micro-sparkline of agent's recent task outcomes
 *
 * Green = success, red = fail, grey = no data.
 * Hover shows summary tooltip.
 *
 * @param {Array} history — [{ success: boolean, timestamp: string }] last 20 tasks
 * @param {'sm'|'md'} size — sm=60x16, md=100x20
 */

import { useMemo } from 'react'

const SIZES = {
  sm: { width: 60, height: 16, barWidth: 2, gap: 1 },
  md: { width: 100, height: 20, barWidth: 3, gap: 1 },
}

export default function AgentActivityPulse({ history = [], size = 'sm' }) {
  const dims = SIZES[size] || SIZES.sm
  const barCount = 20

  const entries = useMemo(() => {
    const arr = history.slice(-barCount)
    while (arr.length < barCount) arr.unshift(null)
    return arr
  }, [history])

  const successCount = entries.filter(e => e?.success).length
  const totalCount = entries.filter(e => e != null).length
  const tooltip = totalCount > 0
    ? `${successCount}/${totalCount} succeeded (${Math.round(successCount / totalCount * 100)}%)`
    : 'No data'

  return (
    <div
      title={tooltip}
      style={{
        width: dims.width,
        height: dims.height,
        display: 'flex',
        alignItems: 'flex-end',
        gap: dims.gap,
        cursor: 'help',
      }}
    >
      {entries.map((entry, i) => {
        let color = 'rgba(255,255,255,0.08)'
        let barHeight = dims.height * 0.3

        if (entry) {
          color = entry.success ? '#10b981' : '#ef4444'
          barHeight = entry.success
            ? dims.height * 0.7
            : dims.height * 0.4
        }

        return (
          <div
            key={i}
            style={{
              width: dims.barWidth,
              height: barHeight,
              background: color,
              borderRadius: 1,
              opacity: entry ? 0.85 : 0.35,
              flexShrink: 0,
            }}
          />
        )
      })}
    </div>
  )
}
