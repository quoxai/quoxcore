/**
 * SkillSparkline — QSKL-7.7b
 *
 * Pure inline-SVG sparkline for a series of score points (0–1).
 * Width: 80px, Height: 24px. Two-tone: above threshold = green, below = orange.
 * No external chart library.
 */

const WIDTH = 80
const HEIGHT = 24
const THRESHOLD = 0.8

export default function SkillSparkline({ points = [] }) {
  if (!points || points.length === 0) {
    return (
      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        aria-hidden="true"
        style={{ display: 'block', flexShrink: 0 }}
      >
        <line x1="0" y1={HEIGHT / 2} x2={WIDTH} y2={HEIGHT / 2} stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
      </svg>
    )
  }

  const n = points.length
  const xStep = n > 1 ? (WIDTH - 4) / (n - 1) : 0
  const toY = (v) => HEIGHT - 2 - (Math.min(1, Math.max(0, v)) * (HEIGHT - 4))

  // Build polyline coords
  const coords = points.map((v, i) => {
    const x = 2 + i * xStep
    const y = toY(v)
    return `${x},${y}`
  })

  // Build individual segments so we can colour each by threshold
  const segments = []
  for (let i = 0; i < n - 1; i++) {
    const x1 = 2 + i * xStep
    const y1 = toY(points[i])
    const x2 = 2 + (i + 1) * xStep
    const y2 = toY(points[i + 1])
    const aboveThreshold = points[i] >= THRESHOLD && points[i + 1] >= THRESHOLD
    segments.push({ x1, y1, x2, y2, aboveThreshold })
  }

  // Dots at each data point
  const dots = points.map((v, i) => ({
    cx: 2 + i * xStep,
    cy: toY(v),
    above: v >= THRESHOLD,
  }))

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0, overflow: 'visible' }}
    >
      {/* Reference threshold line */}
      <line
        x1="0"
        y1={toY(THRESHOLD)}
        x2={WIDTH}
        y2={toY(THRESHOLD)}
        stroke="rgba(255,255,255,0.1)"
        strokeWidth="0.5"
        strokeDasharray="2,3"
      />
      {/* Segments */}
      {segments.map((s, i) => (
        <line
          key={i}
          x1={s.x1}
          y1={s.y1}
          x2={s.x2}
          y2={s.y2}
          stroke={s.aboveThreshold ? '#4ade80' : '#fb923c'}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      ))}
      {/* Dots */}
      {dots.map((d, i) => (
        <circle
          key={i}
          cx={d.cx}
          cy={d.cy}
          r="2"
          fill={d.above ? '#4ade80' : '#fb923c'}
        />
      ))}
    </svg>
  )
}
