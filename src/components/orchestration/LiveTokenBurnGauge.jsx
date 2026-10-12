/**
 * LiveTokenBurnGauge — Circular gauge showing token budget consumption
 *
 * Green <50%, amber 50-80%, red >80%. Projection dashed line if rate provided.
 *
 * @param {number} used — tokens consumed
 * @param {number} total — budget limit
 * @param {number} [rate] — tokens/min for projection
 * @param {number} [size] — diameter (default 64)
 */

function getColor(pct) {
  if (pct < 0.5) return '#10b981'
  if (pct < 0.8) return '#f59e0b'
  return '#ef4444'
}

export default function LiveTokenBurnGauge({ used = 0, total = 100000, rate, size = 64 }) {
  const pct = total > 0 ? Math.min(used / total, 1) : 0
  const color = getColor(pct)
  const radius = (size - 8) / 2
  const cx = size / 2
  const cy = size / 2
  const strokeWidth = 4
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - pct)

  // Projection: where will we be in 10 tasks at current rate?
  const projectedPct = rate && total > 0 ? Math.min((used + rate * 10) / total, 1) : null
  const projectedDashOffset = projectedPct != null ? circumference * (1 - projectedPct) : null

  const pctText = `${Math.round(pct * 100)}%`
  const fontSize = Math.max(9, size * 0.22)
  const smallFontSize = Math.max(7, size * 0.14)

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {/* Background ring */}
      <circle cx={cx} cy={cy} r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={strokeWidth} />

      {/* Projection ring (dashed) */}
      {projectedDashOffset != null && (
        <circle
          cx={cx} cy={cy} r={radius}
          fill="none" stroke={color} strokeWidth={1}
          strokeDasharray={`${circumference * 0.02} ${circumference * 0.02}`}
          strokeDashoffset={projectedDashOffset}
          opacity={0.3}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      )}

      {/* Fill arc */}
      <circle
        cx={cx} cy={cy} r={radius}
        fill="none" stroke={color} strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: 'stroke-dashoffset 0.5s ease, stroke 0.3s ease' }}
      />

      {/* Centre text */}
      <text x={cx} y={cy - 2} textAnchor="middle" dominantBaseline="central"
        fontFamily="var(--m-font-mono, monospace)" fontSize={fontSize} fontWeight={700}
        fill="rgba(255,255,255,0.85)" style={{ fontFeatureSettings: '"tnum"' }}>
        {pctText}
      </text>
      <text x={cx} y={cy + fontSize * 0.8} textAnchor="middle" dominantBaseline="central"
        fontFamily="var(--m-font-mono, monospace)" fontSize={smallFontSize}
        fill="rgba(255,255,255,0.4)">
        {(used / 1000).toFixed(0)}k
      </text>
    </svg>
  )
}
