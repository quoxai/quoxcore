/**
 * PerformanceTrendLine — Micro sparkline of success rate over recent objectives
 *
 * Smooth bezier curve with optional area fill. No axes.
 *
 * @param {Array} data — [{ value: 0-1, timestamp }] last 30 data points
 * @param {number} [width] — default 120
 * @param {number} [height] — default 24
 * @param {string} [color] — default '#10b981'
 * @param {boolean} [showArea] — filled area under line (default true)
 */

import { useMemo } from 'react'

function buildSmoothPath(points, width, height, padding = 2) {
  if (points.length < 2) return { line: '', area: '' }

  const minVal = Math.min(...points.map(p => p.value))
  const maxVal = Math.max(...points.map(p => p.value))
  const range = maxVal - minVal || 1

  const coords = points.map((p, i) => ({
    x: padding + (i / (points.length - 1)) * (width - padding * 2),
    y: padding + (1 - (p.value - minVal) / range) * (height - padding * 2),
  }))

  let d = `M ${coords[0].x} ${coords[0].y}`
  for (let i = 0; i < coords.length - 1; i++) {
    const curr = coords[i]
    const next = coords[i + 1]
    const prev = coords[i - 1] || curr
    const afterNext = coords[i + 2] || next

    const cpx1 = curr.x + (next.x - prev.x) / 4
    const cpy1 = curr.y + (next.y - prev.y) / 4
    const cpx2 = next.x - (afterNext.x - curr.x) / 4
    const cpy2 = next.y - (afterNext.y - curr.y) / 4

    d += ` C ${cpx1} ${cpy1}, ${cpx2} ${cpy2}, ${next.x} ${next.y}`
  }

  const lastCoord = coords[coords.length - 1]
  const firstCoord = coords[0]
  const area = `${d} L ${lastCoord.x} ${height} L ${firstCoord.x} ${height} Z`

  return { line: d, area }
}

export default function PerformanceTrendLine({ data = [], width = 120, height = 24, color = '#10b981', showArea = true }) {
  const { line, area } = useMemo(() => buildSmoothPath(data, width, height), [data, width, height])

  if (data.length < 2) return null

  // Determine if trending down
  const recentAvg = data.slice(-5).reduce((s, p) => s + p.value, 0) / Math.min(data.length, 5)
  const effectiveColor = recentAvg < 0.5 ? '#ef4444' : recentAvg < 0.7 ? '#f59e0b' : color

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
      {showArea && area && (
        <path d={area} fill={effectiveColor} opacity={0.08} />
      )}
      {line && (
        <path d={line} fill="none" stroke={effectiveColor} strokeWidth={1.5} strokeLinecap="round" />
      )}
    </svg>
  )
}
