/**
 * TimeSeriesChart — Area/line chart using pure SVG.
 * Renders a time series with filled area, line path, and hover tooltips.
 *
 * Props:
 *   data: [{ date, total, sent, failed }]
 *   height: SVG height (default 200)
 *   color: primary fill color (default blue)
 */

export default function TimeSeriesChart({ data = [], height = 200, color = 'var(--ui-blue, #3b82f6)' }) {
  if (!data.length) {
    return (
      <div className="comms-chart comms-chart--empty">
        <span>No data</span>
      </div>
    )
  }

  const padLeft = 40
  const padRight = 16
  const padTop = 16
  const padBottom = 32
  const vbWidth = 500
  const chartW = vbWidth - padLeft - padRight
  const chartH = height - padTop - padBottom

  const maxVal = Math.max(...data.map(d => d.total), 1)
  // Round up to nice grid value
  const gridMax = Math.ceil(maxVal / 5) * 5 || 5
  const gridLines = 4

  const xStep = data.length > 1 ? chartW / (data.length - 1) : chartW

  const toX = (i) => padLeft + (i * xStep)
  const toY = (v) => padTop + chartH - (v / gridMax) * chartH

  // Build area polygon points
  const linePoints = data.map((d, i) => `${toX(i)},${toY(d.total)}`).join(' ')
  const areaPoints = [
    `${toX(0)},${toY(0)}`,
    ...data.map((d, i) => `${toX(i)},${toY(d.total)}`),
    `${toX(data.length - 1)},${toY(0)}`
  ].join(' ')

  // Failed line (if any failed)
  const hasFailed = data.some(d => d.failed > 0)
  const failedPoints = hasFailed
    ? data.map((d, i) => `${toX(i)},${toY(d.failed)}`).join(' ')
    : null

  // Date labels — show first, middle, and last
  const labelIndices = data.length <= 3
    ? data.map((_, i) => i)
    : [0, Math.floor(data.length / 2), data.length - 1]

  const formatDate = (dateStr) => {
    const parts = dateStr.split('-')
    return `${parts[1]}/${parts[2]}`
  }

  return (
    <div className="comms-chart">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${vbWidth} ${height}`}
        preserveAspectRatio="xMinYMid meet"
      >
        {/* Grid lines */}
        {Array.from({ length: gridLines + 1 }).map((_, i) => {
          const val = (gridMax / gridLines) * i
          const y = toY(val)
          return (
            <g key={`grid-${i}`}>
              <line
                x1={padLeft}
                y1={y}
                x2={vbWidth - padRight}
                y2={y}
                stroke="rgba(255, 255, 255, 0.06)"
                strokeWidth="1"
              />
              <text
                x={padLeft - 6}
                y={y}
                textAnchor="end"
                dominantBaseline="central"
                fill="var(--ui-text-muted, #666)"
                fontSize="10"
                fontFamily="inherit"
              >
                {Math.round(val)}
              </text>
            </g>
          )
        })}

        {/* Area fill */}
        <polygon
          points={areaPoints}
          fill={color}
          opacity="0.12"
        />

        {/* Total line */}
        <polyline
          points={linePoints}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Failed line */}
        {failedPoints && (
          <polyline
            points={failedPoints}
            fill="none"
            stroke="var(--ui-red, #ef4444)"
            strokeWidth="1.5"
            strokeDasharray="4 3"
            strokeLinecap="round"
          />
        )}

        {/* Data points with tooltips */}
        {data.map((d, i) => (
          <circle
            key={i}
            cx={toX(i)}
            cy={toY(d.total)}
            r="4"
            fill={color}
            stroke="var(--ui-bg-primary, #0f0f18)"
            strokeWidth="2"
            opacity="0.7"
          >
            <title>{`${d.date}: ${d.total} total, ${d.sent || 0} sent, ${d.failed || 0} failed`}</title>
          </circle>
        ))}

        {/* X-axis date labels */}
        {labelIndices.map(i => (
          <text
            key={`label-${i}`}
            x={toX(i)}
            y={height - 8}
            textAnchor="middle"
            fill="var(--ui-text-muted, #666)"
            fontSize="10"
            fontFamily="inherit"
          >
            {formatDate(data[i].date)}
          </text>
        ))}
      </svg>
    </div>
  )
}
