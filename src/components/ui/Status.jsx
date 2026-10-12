/**
 * Status Component
 *
 * Status indicators, dots, and labels.
 *
 * @example
 * // Status with dot
 * <Status status="success" label="Online" />
 *
 * // Pulsing status
 * <Status status="warning" pulse label="Processing" />
 *
 * // Status dot only
 * <StatusDot status="error" />
 */

/**
 * StatusDot - Simple status indicator dot
 *
 * Props:
 * - status: 'success' | 'warning' | 'error' | 'info' | 'muted'
 * - pulse: boolean - Animate with pulse effect
 * - pulseFast: boolean - Fast pulse (for alerts)
 * - size: 'sm' | 'md' | 'lg'
 * - className: string
 */
export function StatusDot({
  status = 'muted',
  pulse = false,
  pulseFast = false,
  size = 'md',
  className = ''
}) {
  const classes = [
    'ui-status-dot',
    `ui-status-dot-${status}`,
    pulse && 'ui-status-dot-pulse',
    pulseFast && 'ui-status-dot-pulse-fast',
    className
  ].filter(Boolean).join(' ')

  const sizeMap = { sm: 6, md: 8, lg: 10 }

  return (
    <span
      className={classes}
      style={{
        width: `${sizeMap[size]}px`,
        height: `${sizeMap[size]}px`
      }}
      role="status"
      aria-label={status}
    />
  )
}

/**
 * Status - Status indicator with label
 *
 * Props:
 * - status: 'success' | 'warning' | 'error' | 'info' | 'muted'
 * - label: string
 * - pulse: boolean
 * - pulseFast: boolean
 * - size: 'sm' | 'md' | 'lg'
 * - className: string
 */
export function Status({
  status = 'muted',
  label,
  pulse = false,
  pulseFast = false,
  size = 'md',
  className = ''
}) {
  return (
    <div className={`ui-status ${className}`}>
      <StatusDot
        status={status}
        pulse={pulse}
        pulseFast={pulseFast}
        size={size}
      />
      {label && <span className="ui-status-label">{label}</span>}
    </div>
  )
}

/**
 * ConnectionStatus - Connection/online status indicator
 *
 * Props:
 * - connected: boolean
 * - label: string - Custom label (default: Connected/Disconnected)
 * - showLabel: boolean
 */
export function ConnectionStatus({
  connected = false,
  label,
  showLabel = true,
  className = ''
}) {
  const effectiveLabel = label || (connected ? 'Connected' : 'Disconnected')

  return (
    <Status
      status={connected ? 'success' : 'error'}
      label={showLabel ? effectiveLabel : undefined}
      pulse={connected}
      className={className}
    />
  )
}

/**
 * HealthStatus - Health indicator (for services, hosts, etc.)
 *
 * Props:
 * - health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
 * - label: string
 */
export function HealthStatus({
  health = 'unknown',
  label,
  className = ''
}) {
  const statusMap = {
    healthy: 'success',
    degraded: 'warning',
    unhealthy: 'error',
    unknown: 'muted'
  }

  const labelMap = {
    healthy: 'Healthy',
    degraded: 'Degraded',
    unhealthy: 'Unhealthy',
    unknown: 'Unknown'
  }

  return (
    <Status
      status={statusMap[health] || 'muted'}
      label={label || labelMap[health] || health}
      pulse={health === 'healthy'}
      pulseFast={health === 'unhealthy'}
      className={className}
    />
  )
}

/**
 * OnlineIndicator - Simple online/offline dot
 */
export function OnlineIndicator({ online = false, className = '' }) {
  return (
    <StatusDot
      status={online ? 'success' : 'muted'}
      pulse={online}
      className={className}
    />
  )
}

/**
 * StatusBanner - Full-width status banner
 *
 * Props:
 * - status: 'success' | 'warning' | 'error' | 'info'
 * - message: string
 * - onDismiss: function
 */
export function StatusBanner({
  status = 'info',
  message,
  onDismiss,
  className = ''
}) {
  const colorMap = {
    success: { bg: 'rgba(48, 255, 144, 0.1)', border: 'rgba(48, 255, 144, 0.3)', text: 'var(--ui-green)' },
    warning: { bg: 'rgba(255, 176, 48, 0.1)', border: 'rgba(255, 176, 48, 0.3)', text: 'var(--ui-amber)' },
    error: { bg: 'rgba(255, 48, 48, 0.1)', border: 'rgba(255, 48, 48, 0.3)', text: 'var(--ui-red-light)' },
    info: { bg: 'rgba(48, 144, 255, 0.1)', border: 'rgba(48, 144, 255, 0.3)', text: 'var(--ui-blue)' }
  }

  const colors = colorMap[status] || colorMap.info

  return (
    <div
      className={`ui-status-banner ${className}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'var(--ui-space-3, 0.75rem) var(--ui-space-4, 1rem)',
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 'var(--ui-radius-md, 6px)',
        color: colors.text
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-space-2, 0.5rem)' }}>
        <StatusDot status={status} pulse={status === 'warning' || status === 'error'} />
        <span style={{ fontSize: 'var(--ui-text-sm, 0.75rem)' }}>{message}</span>
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            padding: 'var(--ui-space-1, 0.25rem)',
            opacity: 0.7
          }}
          aria-label="Dismiss"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      )}
    </div>
  )
}

export default Status
