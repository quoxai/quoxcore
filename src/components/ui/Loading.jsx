/**
 * Loading Components
 *
 * Loading states, spinners, and skeleton placeholders.
 *
 * @example
 * // Spinner
 * <Spinner />
 * <Spinner size="lg" />
 *
 * // Loading with message
 * <Loading message="Loading data..." />
 *
 * // Skeleton placeholders
 * <Skeleton type="text" />
 * <Skeleton type="avatar" />
 * <Skeleton type="card" />
 *
 * // Skeleton text lines
 * <SkeletonText lines={3} />
 */

/**
 * Spinner - Animated loading spinner
 *
 * Props:
 * - size: 'sm' | 'md' | 'lg'
 * - color: CSS color value (defaults to blue)
 * - className: string
 */
export function Spinner({ size = 'md', color, className = '' }) {
  const sizeClass = size !== 'md' ? `ui-spinner-${size}` : ''

  return (
    <div
      className={`ui-spinner ${sizeClass} ${className}`}
      style={color ? { borderTopColor: color } : undefined}
      role="status"
      aria-label="Loading"
    />
  )
}

/**
 * Loading - Full loading state with spinner and optional message
 *
 * Props:
 * - message: string - Optional loading message
 * - size: 'sm' | 'md' | 'lg' - Spinner size
 * - className: string
 */
export function Loading({ message, size = 'md', className = '' }) {
  return (
    <div className={`ui-loading ${className}`}>
      <Spinner size={size} />
      {message && <span>{message}</span>}
    </div>
  )
}

/**
 * Skeleton - Shimmer placeholder for loading content
 *
 * Props:
 * - type: 'text' | 'avatar' | 'card' | 'inline'
 * - width: CSS width value
 * - height: CSS height value
 * - className: string
 */
export function Skeleton({
  type = 'text',
  width,
  height,
  className = '',
  style = {}
}) {
  const classes = [
    'ui-skeleton',
    `ui-skeleton-${type}`,
    className
  ].filter(Boolean).join(' ')

  return (
    <div
      className={classes}
      style={{
        width,
        height,
        ...style
      }}
      aria-hidden="true"
    />
  )
}

/**
 * SkeletonText - Multiple skeleton text lines
 *
 * Props:
 * - lines: number - Number of lines to show
 * - className: string
 */
export function SkeletonText({ lines = 3, className = '' }) {
  return (
    <div className={`ui-skeleton-text-group ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          type="text"
          style={{
            width: i === lines - 1 ? '60%' : '100%'
          }}
        />
      ))}
    </div>
  )
}

/**
 * SkeletonCard - Skeleton placeholder for card content
 *
 * Props:
 * - showHeader: boolean
 * - showFooter: boolean
 * - lines: number - Number of content lines
 */
export function SkeletonCard({
  showHeader = true,
  showFooter = false,
  lines = 2,
  className = ''
}) {
  return (
    <div className={`ui-card ${className}`}>
      {showHeader && (
        <div className="ui-card-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Skeleton type="avatar" style={{ width: 24, height: 24 }} />
            <Skeleton type="text" style={{ width: '120px', height: '1rem' }} />
          </div>
        </div>
      )}
      <div className="ui-card-body">
        <SkeletonText lines={lines} />
      </div>
      {showFooter && (
        <div className="ui-card-footer">
          <Skeleton type="text" style={{ width: '80px', height: '32px', borderRadius: '6px' }} />
        </div>
      )}
    </div>
  )
}

/**
 * SkeletonList - Skeleton placeholder for list items
 *
 * Props:
 * - count: number - Number of list items
 * - showIcon: boolean - Show icon placeholder
 */
export function SkeletonList({ count = 5, showIcon = true, className = '' }) {
  return (
    <div className={`ui-skeleton-list ${className}`} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="ui-list-item"
          style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}
        >
          {showIcon && (
            <Skeleton type="avatar" style={{ width: 32, height: 32, flexShrink: 0 }} />
          )}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <Skeleton type="text" style={{ width: '60%', height: '0.875rem' }} />
            <Skeleton type="text" style={{ width: '40%', height: '0.65rem' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * SkeletonTable - Skeleton placeholder for tables
 *
 * Props:
 * - rows: number - Number of rows
 * - columns: number - Number of columns
 */
export function SkeletonTable({ rows = 5, columns = 4, className = '' }) {
  return (
    <div className={`ui-skeleton-table ${className}`}>
      {/* Header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: '1rem',
        padding: '0.75rem 1rem',
        borderBottom: '1px solid var(--ui-border)'
      }}>
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} type="text" style={{ height: '0.75rem' }} />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
          key={rowIndex}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, 1fr)`,
            gap: '1rem',
            padding: '0.75rem 1rem',
            borderBottom: '1px solid var(--ui-border)'
          }}
        >
          {Array.from({ length: columns }).map((_, colIndex) => (
            <Skeleton
              key={colIndex}
              type="text"
              style={{
                height: '0.875rem',
                width: colIndex === 0 ? '80%' : `${60 + Math.random() * 30}%`
              }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * LoadingOverlay - Full overlay with loading state
 *
 * Props:
 * - message: string
 * - visible: boolean
 */
export function LoadingOverlay({ message = 'Loading...', visible = true }) {
  if (!visible) return null

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'var(--glass-blur)',
        zIndex: 10
      }}
    >
      <Loading message={message} />
    </div>
  )
}

export default Spinner
