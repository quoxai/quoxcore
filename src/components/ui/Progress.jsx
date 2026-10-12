/**
 * Progress Component
 *
 * Progress bars and resource indicators.
 *
 * @example
 * // Basic progress bar
 * <Progress value={75} />
 *
 * // With label
 * <Progress value={45} label="CPU" />
 *
 * // Auto-colored based on value
 * <Progress value={85} autoColor />
 *
 * // Resource bar (CPU/Memory/Disk style)
 * <ResourceBar label="CPU" value={65} detail="2.4 GHz" type="cpu" />
 */

/**
 * Progress - Basic progress bar
 *
 * Props:
 * - value: number (0-100)
 * - color: 'green' | 'blue' | 'amber' | 'orange' | 'red' | 'purple' | or gradient name
 * - autoColor: boolean - Automatically color based on value (green < 70, amber < 90, red >= 90)
 * - size: 'sm' | 'md' | 'lg'
 * - label: string - Optional label
 * - showValue: boolean - Show percentage value
 * - className: string
 */
export function Progress({
  value = 0,
  color = 'blue',
  autoColor = false,
  size = 'md',
  label,
  showValue = false,
  className = ''
}) {
  // Clamp value between 0 and 100
  const normalizedValue = Math.max(0, Math.min(100, value))

  // Determine color based on value if autoColor is true
  const effectiveColor = autoColor
    ? normalizedValue >= 90
      ? 'red'
      : normalizedValue >= 70
      ? 'amber'
      : 'green'
    : color

  const heightMap = { sm: '4px', md: '6px', lg: '8px' }

  return (
    <div className={`ui-progress-container ${className}`}>
      {(label || showValue) && (
        <div className="ui-progress-header" style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 'var(--ui-space-1, 0.25rem)',
          fontSize: 'var(--ui-text-xs, 0.65rem)',
          color: 'var(--ui-text-muted)'
        }}>
          {label && <span>{label}</span>}
          {showValue && <span>{Math.round(normalizedValue)}%</span>}
        </div>
      )}
      <div
        className="ui-progress"
        style={{ height: heightMap[size] }}
        role="progressbar"
        aria-valuenow={normalizedValue}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`ui-progress-bar ui-progress-${effectiveColor}`}
          style={{ width: `${normalizedValue}%` }}
        />
      </div>
    </div>
  )
}

/**
 * ResourceBar - Resource usage indicator (CPU/Memory/Disk style)
 *
 * Props:
 * - label: string - Resource name (CPU, Memory, Disk)
 * - value: number (0-100)
 * - detail: string - Additional detail text (e.g., "4.2 GB / 16 GB")
 * - type: 'cpu' | 'memory' | 'disk' | 'network' - Determines gradient color
 * - className: string
 */
export function ResourceBar({
  label,
  value = 0,
  detail,
  type = 'cpu',
  className = ''
}) {
  const normalizedValue = Math.max(0, Math.min(100, value))

  const gradientMap = {
    cpu: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
    memory: 'linear-gradient(90deg, #8b5cf6, #a78bfa)',
    disk: 'linear-gradient(90deg, #f59e0b, #fbbf24)',
    network: 'linear-gradient(90deg, #10b981, #34d399)'
  }

  return (
    <div className={`ui-resource-bar ${className}`} style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--ui-space-2, 0.5rem)'
    }}>
      <span style={{
        width: '40px',
        fontSize: 'var(--ui-text-xs, 0.65rem)',
        fontWeight: 600,
        color: 'var(--ui-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.03em'
      }}>
        {label}
      </span>
      <div style={{
        flex: 1,
        height: '6px',
        background: 'rgba(255, 255, 255, 0.1)',
        borderRadius: '3px',
        overflow: 'hidden'
      }}>
        <div style={{
          height: '100%',
          width: `${normalizedValue}%`,
          background: gradientMap[type] || gradientMap.cpu,
          borderRadius: '3px',
          transition: 'width 0.3s ease'
        }} />
      </div>
      <span style={{
        minWidth: '60px',
        fontSize: 'var(--ui-text-xs, 0.65rem)',
        fontFamily: 'var(--ui-font-mono)',
        color: 'var(--ui-text-secondary)',
        textAlign: 'right'
      }}>
        {detail || `${Math.round(normalizedValue)}%`}
      </span>
    </div>
  )
}

/**
 * StorageBar - Storage usage indicator with used/total
 *
 * Props:
 * - used: number - Used amount
 * - total: number - Total capacity
 * - unit: string - Unit label (GB, MB, etc.)
 * - label: string - Optional label
 * - className: string
 */
export function StorageBar({
  used,
  total,
  unit = 'GB',
  label = 'Storage',
  className = ''
}) {
  const percent = total > 0 ? (used / total) * 100 : 0
  const normalizedPercent = Math.max(0, Math.min(100, percent))

  const color = normalizedPercent >= 90 ? 'red' : normalizedPercent >= 70 ? 'amber' : 'green'

  return (
    <div className={`ui-storage-bar ${className}`}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 'var(--ui-space-2, 0.5rem)'
      }}>
        <span style={{
          fontSize: 'var(--ui-text-sm, 0.75rem)',
          color: 'var(--ui-text-secondary)'
        }}>
          {label}
        </span>
        <span style={{
          fontSize: 'var(--ui-text-xs, 0.65rem)',
          fontFamily: 'var(--ui-font-mono)',
          color: 'var(--ui-text-muted)'
        }}>
          {used.toFixed(1)} / {total.toFixed(1)} {unit}
        </span>
      </div>
      <div className="ui-progress" style={{ height: '8px' }}>
        <div
          className={`ui-progress-bar ui-progress-${color}`}
          style={{ width: `${normalizedPercent}%` }}
        />
      </div>
      <div style={{
        marginTop: 'var(--ui-space-1, 0.25rem)',
        fontSize: 'var(--ui-text-xs, 0.65rem)',
        color: normalizedPercent >= 90 ? 'var(--ui-red)' : 'var(--ui-text-muted)',
        textAlign: 'right'
      }}>
        {Math.round(normalizedPercent)}% used
      </div>
    </div>
  )
}

/**
 * CircularProgress - Circular progress indicator
 *
 * Props:
 * - value: number (0-100)
 * - size: number (px)
 * - strokeWidth: number
 * - color: CSS color
 * - showValue: boolean
 * - className: string
 */
export function CircularProgress({
  value = 0,
  size = 60,
  strokeWidth = 4,
  color = 'var(--ui-blue)',
  showValue = true,
  className = ''
}) {
  const normalizedValue = Math.max(0, Math.min(100, value))
  const radius = (size - strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  const offset = circumference - (normalizedValue / 100) * circumference

  return (
    <div className={`ui-circular-progress ${className}`} style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255, 255, 255, 0.1)"
          strokeWidth={strokeWidth}
        />
        {/* Progress circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.3s ease' }}
        />
      </svg>
      {showValue && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: size * 0.25,
          fontWeight: 600,
          color: 'var(--ui-text-primary)'
        }}>
          {Math.round(normalizedValue)}%
        </div>
      )}
    </div>
  )
}

export default Progress
