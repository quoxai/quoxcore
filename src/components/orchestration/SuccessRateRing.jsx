/**
 * SuccessRateRing — Tiny donut chart with percentage in centre
 *
 * Adapted from quox-remotion reference. Remotion deps removed.
 * SVG-only, no external dependencies. Smooth CSS transition on rate change.
 *
 * @param {number} rate — 0 to 1 (success rate)
 * @param {number} size — diameter in px (default 32)
 * @param {boolean} showLabel — show % text in centre (default true)
 * @param {number} strokeWidth — ring thickness (default 3)
 */

function getRateColor(rate) {
  if (rate >= 0.8) return '#10b981'
  if (rate >= 0.5) return '#f59e0b'
  return '#ef4444'
}

export default function SuccessRateRing({ rate = 0, size = 32, showLabel = true, strokeWidth = 3 }) {
  const color = getRateColor(rate)
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const center = size / 2
  const dashOffset = circumference * (1 - rate)
  const pctText = `${Math.round(rate * 100)}%`
  const fontSize = Math.max(7, size * 0.28)

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible' }}>
      {/* Background ring */}
      <circle
        cx={center} cy={center} r={radius}
        fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={strokeWidth}
      />
      {/* Foreground arc */}
      <circle
        cx={center} cy={center} r={radius}
        fill="none" stroke={color} strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        transform={`rotate(-90 ${center} ${center})`}
        style={{ transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease' }}
      />
      {/* Centre label */}
      {showLabel && (
        <text
          x={center} y={center}
          textAnchor="middle" dominantBaseline="central"
          fontFamily="var(--m-font-mono, 'JetBrains Mono', monospace)"
          fontSize={fontSize} fontWeight={700}
          fill="rgba(255,255,255,0.85)"
          style={{ fontFeatureSettings: '"tnum"' }}
        >
          {pctText}
        </text>
      )}
    </svg>
  )
}
