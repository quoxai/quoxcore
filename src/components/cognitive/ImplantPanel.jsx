/**
 * ImplantPanel Component
 *
 * Renders a single cognitive implant panel with real data.
 * Handles active, dormant, and locked states.
 */

import { useNavigate } from 'react-router-dom'

// Format metric values based on type
function formatValue(value, format) {
  if (value === null || value === undefined) return '—'

  switch (format) {
    case 'percent':
      return `${Math.round(value)}%`
    case 'number':
      return typeof value === 'number' ? value.toLocaleString() : value
    case 'ratio':
      return value
    case 'ms':
      return `${value}ms`
    case 'duration':
      if (value < 1000) return `${value}ms`
      if (value < 60000) return `${(value / 1000).toFixed(1)}s`
      return `${Math.round(value / 60000)}m`
    case 'bytes':
      if (value < 1024) return `${value}B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`
      return `${(value / (1024 * 1024)).toFixed(1)}MB`
    case 'timeago':
      if (!value) return 'Never'
      const diff = Date.now() - new Date(value).getTime()
      if (diff < 60000) return 'Just now'
      if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`
      if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
      return `${Math.round(diff / 86400000)}d ago`
    case 'status':
      return value
    default:
      return String(value)
  }
}

// Determine implant status from data
function getImplantStatus(data, implant) {
  if (!data) return 'dormant'

  const primaryMetric = implant.metrics?.find((m) => m.primary)
  if (!primaryMetric) return 'active'

  const value = data[primaryMetric.key]
  if (value === null || value === undefined) return 'dormant'

  // Status thresholds based on metric type
  if (primaryMetric.format === 'percent') {
    if (value >= 80) return 'active'
    if (value >= 50) return 'warning'
    return 'dormant'
  }

  return 'active'
}

// Lock icon SVG
function LockIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  )
}

// Chip icon SVG (computer chip/implant)
function ChipIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" strokeLinecap="round" />
    </svg>
  )
}

// Info icon for tooltip
function InfoIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
    </svg>
  )
}

// Locked state content
function LockedState({ pluginId }) {
  const navigate = useNavigate()

  return (
    <div className="implant-locked">
      <LockIcon className="implant-locked__icon" />
      <p className="implant-locked__message">Available with Premium</p>
      <button
        className="implant-locked__cta"
        onClick={() => navigate(`/plugins?highlight=${pluginId}`)}
      >
        View Plugin
      </button>
    </div>
  )
}

// Dormant state content
function DormantState({ message = 'Awaiting data...' }) {
  return (
    <div className="implant-dormant">
      <p className="implant-dormant__message">{message}</p>
    </div>
  )
}

// Primary metric display
function PrimaryMetric({ metric, value }) {
  return (
    <div className="implant-metric--primary">
      <span className="implant-metric__value--primary">{formatValue(value, metric.format)}</span>
      <span className="implant-metric__label--primary">{metric.label}</span>
    </div>
  )
}

// Secondary metrics list
function MetricsList({ metrics, data }) {
  return (
    <div className="implant-metrics-list">
      {metrics.map((metric) => (
        <div key={metric.key} className="implant-metric">
          <span className="implant-metric__label">{metric.label}</span>
          <span className="implant-metric__value">{formatValue(data[metric.key], metric.format)}</span>
        </div>
      ))}
    </div>
  )
}

// Breakdown row
function BreakdownRow({ items, data }) {
  return (
    <div className="implant-breakdown">
      {items.map((item) => (
        <div key={item.key} className="implant-breakdown__item">
          <span className="implant-breakdown__label">{item.label}:</span>
          <span className="implant-breakdown__value">{formatValue(data[item.key], 'number')}</span>
        </div>
      ))}
    </div>
  )
}

// Progress bar for primary metrics
function ProgressBar({ value, color }) {
  const percent = Math.min(100, Math.max(0, value || 0))
  return (
    <div className="implant-progress">
      <div
        className="implant-progress__fill"
        style={{ width: `${percent}%`, '--implant-color': color }}
      />
    </div>
  )
}

/**
 * Main ImplantPanel Component
 */
export default function ImplantPanel({ implant, data, isLocked }) {
  const status = isLocked ? 'locked' : getImplantStatus(data, implant)
  const primaryMetric = implant.metrics?.find((m) => m.primary)
  const secondaryMetrics = implant.metrics?.filter((m) => !m.primary) || []
  const showProgress = primaryMetric?.format === 'percent' && data && !isLocked

  return (
    <div
      className={`implant-panel implant-panel--${status}`}
      style={{ '--implant-color': implant.color }}
    >
      <div className="implant-panel__header">
        <ChipIcon className="implant-panel__chip-icon" />
        <span className={`implant-panel__status-dot implant-panel__status-dot--${status}`} />
        <h3 className="implant-panel__name">{implant.name}</h3>
        {isLocked && <LockIcon className="implant-panel__lock" />}
        <div className="implant-panel__info-wrapper">
          <InfoIcon className="implant-panel__info-icon" />
          <div className="implant-panel__tooltip">
            <p className="implant-panel__tooltip-desc">{implant.description}</p>
            {implant.howToGrow && (
              <p className="implant-panel__tooltip-grow">
                <strong>Growth:</strong> {implant.howToGrow}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="implant-panel__body">
        {isLocked ? (
          <LockedState pluginId={implant.requiredPlugins?.[0]} />
        ) : data ? (
          <>
            {primaryMetric && (
              <>
                <PrimaryMetric metric={primaryMetric} value={data[primaryMetric.key]} />
                {showProgress && <ProgressBar value={data[primaryMetric.key]} color={implant.color} />}
              </>
            )}
            {secondaryMetrics.length > 0 && <MetricsList metrics={secondaryMetrics} data={data} />}
            {implant.breakdown && <BreakdownRow items={implant.breakdown} data={data} />}
          </>
        ) : (
          <DormantState message={implant.comingSoon ? 'Coming soon' : 'Awaiting data...'} />
        )}
      </div>
    </div>
  )
}
