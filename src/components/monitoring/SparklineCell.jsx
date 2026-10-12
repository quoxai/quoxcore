/**
 * SparklineCell — Tiny inline SVG sparkline for resource metrics.
 *
 * Renders a 48×16 polyline from a ring buffer of values (0-1 range).
 * Color follows threshold: green < 50%, amber 50-80%, red > 80%.
 */

import { memo } from 'react'

const WIDTH = 48
const HEIGHT = 14
const PADDING = 1

function getSparkColor(values) {
  if (!values || values.length === 0) return '#30ff90'
  const last = values[values.length - 1]
  const pct = last * 100
  if (pct > 80) return '#ff6b30'
  if (pct > 50) return '#ffb030'
  return '#30ff90'
}

function buildPoints(values) {
  if (!values || values.length < 2) return ''
  const usableW = WIDTH - PADDING * 2
  const usableH = HEIGHT - PADDING * 2
  const step = usableW / (values.length - 1)

  return values.map((v, i) => {
    const x = PADDING + i * step
    const y = PADDING + usableH - Math.min(Math.max(v, 0), 1) * usableH
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}

export const SparklineCell = memo(function SparklineCell({ values }) {
  if (!values || values.length < 2) return null

  const color = getSparkColor(values)
  const points = buildPoints(values)

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="pxt-sparkline"
      style={{ display: 'block', marginTop: 1 }}
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ opacity: 0.7 }}
      />
    </svg>
  )
}, (prev, next) => {
  // Only re-render when the last value changes
  const pv = prev.values
  const nv = next.values
  if (!pv && !nv) return true
  if (!pv || !nv) return false
  if (pv.length !== nv.length) return false
  return pv[pv.length - 1] === nv[nv.length - 1]
})

export default SparklineCell
