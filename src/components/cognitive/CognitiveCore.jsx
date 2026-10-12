/**
 * CognitiveCore Component
 *
 * The central brain panel showing aggregate system health.
 * Larger and more prominent than peripheral implants.
 */

// Brain icon SVG
function BrainIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 4.5c-1.5 0-2.75.75-3.5 1.75-.5.75-1.25 1.25-2.25 1.25-1.75 0-3.25 1.5-3.25 3.25 0 1 .5 2 1.25 2.5-.5.75-.75 1.5-.75 2.5 0 2 1.5 3.75 3.5 4 .25 1.25 1.5 2.25 3 2.25.75 0 1.5-.25 2-.75.5.5 1.25.75 2 .75 1.5 0 2.75-1 3-2.25 2-.25 3.5-2 3.5-4 0-1-.25-1.75-.75-2.5.75-.5 1.25-1.5 1.25-2.5 0-1.75-1.5-3.25-3.25-3.25-1 0-1.75-.5-2.25-1.25-.75-1-2-1.75-3.5-1.75z" />
      <path d="M12 4.5v17.5" strokeDasharray="2 2" opacity="0.5" />
      <path d="M9 8c.5 1 1.5 1.5 3 1.5s2.5-.5 3-1.5" opacity="0.5" />
      <path d="M8 12c1 .75 2.5 1 4 1s3-.25 4-1" opacity="0.5" />
      <path d="M9 16c.5-.75 1.5-1 3-1s2.5.25 3 1" opacity="0.5" />
    </svg>
  )
}

export default function CognitiveCore({ data }) {
  const status = data?.status || 'unknown'
  const health = data?.overallHealth ?? 0
  const activeServices = data?.activeServices ?? 0
  const totalServices = data?.totalServices ?? 0

  const statusClass =
    status === 'operational'
      ? 'cognitive-core--operational'
      : status === 'degraded'
        ? 'cognitive-core--degraded'
        : status === 'critical'
          ? 'cognitive-core--critical'
          : ''

  return (
    <div className={`cognitive-core ${statusClass}`}>
      <BrainIcon className="cognitive-core__icon" />
      <h2 className="cognitive-core__title">Cognitive Core</h2>
      <p className="cognitive-core__status">
        {status === 'operational'
          ? 'All systems operational'
          : status === 'degraded'
            ? 'System degraded'
            : status === 'critical'
              ? 'Critical issues detected'
              : 'Status unknown'}
      </p>
      <div className="cognitive-core__health">{health}%</div>
      <div className="cognitive-core__health-label">System Health</div>

      {totalServices > 0 && (
        <div className="cognitive-core__services">
          <div className="cognitive-core__service-stat">
            <div className="cognitive-core__service-value">{activeServices}</div>
            <div className="cognitive-core__service-label">Active</div>
          </div>
          <div className="cognitive-core__service-stat">
            <div className="cognitive-core__service-value">{totalServices}</div>
            <div className="cognitive-core__service-label">Total</div>
          </div>
        </div>
      )}
    </div>
  )
}
