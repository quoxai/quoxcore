/**
 * BarChart — Horizontal bar chart using pure SVG.
 * Renders labeled bars proportional to the max value.
 *
 * Props:
 *   data: [{ label, value, color }]
 *   height: total SVG height (auto-calculated if omitted)
 *   barHeight: height of each bar (default 22)
 *   labelWidth: left margin for labels (default 80)
 */

export default function BarChart({ data = [], height, barHeight = 22, labelWidth = 80 }) {
  if (!data.length) {
    return (
      <div className="comms-chart comms-chart--empty">
        <span>No data</span>
      </div>
    )
  }

  const gap = 6
  const rightPad = 50
  const computedHeight = height || (data.length * (barHeight + gap) + gap)
  const maxVal = Math.max(...data.map(d => d.value), 1)
  const barAreaWidth = 300 // internal coordinate system

  return (
    <div className="comms-chart">
      <svg
        width="100%"
        height={computedHeight}
        viewBox={`0 0 ${labelWidth + barAreaWidth + rightPad} ${computedHeight}`}
        preserveAspectRatio="xMinYMin meet"
      >
        {data.map((d, i) => {
          const y = gap + i * (barHeight + gap)
          const barW = (d.value / maxVal) * barAreaWidth
          const color = d.color || 'var(--ui-blue, #3b82f6)'

          return (
            <g key={d.label}>
              {/* Label */}
              <text
                x={labelWidth - 8}
                y={y + barHeight / 2}
                textAnchor="end"
                dominantBaseline="central"
                fill="var(--ui-text-secondary, #999)"
                fontSize="12"
                fontFamily="inherit"
              >
                {d.label.length > 10 ? d.label.slice(0, 10) + '...' : d.label}
              </text>

              {/* Bar background */}
              <rect
                x={labelWidth}
                y={y}
                width={barAreaWidth}
                height={barHeight}
                fill="rgba(255, 255, 255, 0.03)"
                rx="3"
              />

              {/* Bar fill */}
              <rect
                x={labelWidth}
                y={y}
                width={Math.max(barW, 2)}
                height={barHeight}
                fill={color}
                rx="3"
                opacity="0.85"
              >
                <title>{`${d.label}: ${d.value}`}</title>
              </rect>

              {/* Value label */}
              <text
                x={labelWidth + Math.max(barW, 2) + 8}
                y={y + barHeight / 2}
                dominantBaseline="central"
                fill="var(--ui-text-muted, #666)"
                fontSize="12"
                fontFamily="inherit"
                fontWeight="600"
              >
                {d.value}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
