/**
 * Empty & Error State Components
 *
 * Standardized empty states and error displays.
 *
 * @example
 * // Empty state
 * <Empty
 *   icon={<FolderIcon />}
 *   title="No files"
 *   description="Upload files to get started"
 * >
 *   <Button variant="primary">Upload</Button>
 * </Empty>
 *
 * // Error state
 * <ErrorState
 *   message="Failed to load data"
 *   onRetry={handleRetry}
 * />
 *
 * // Inline error
 * <ErrorMessage message="Something went wrong" />
 */

import Button from './Button'

/**
 * Empty - Empty state placeholder
 *
 * Props:
 * - icon: ReactNode - Icon to display
 * - title: string - Main title
 * - description: string - Supporting text
 * - children: ReactNode - Action buttons or additional content
 * - className: string
 */
export function Empty({
  icon,
  title,
  description,
  children,
  className = ''
}) {
  return (
    <div className={`ui-empty ${className}`}>
      {icon && <div className="ui-empty-icon">{icon}</div>}
      {title && <h3 className="ui-empty-title">{title}</h3>}
      {description && <p className="ui-empty-description">{description}</p>}
      {children}
    </div>
  )
}

/**
 * ErrorState - Error display with optional retry
 *
 * Props:
 * - title: string - Error title
 * - message: string - Error message
 * - onRetry: function - Retry callback
 * - inline: boolean - Use inline compact style
 * - className: string
 */
export function ErrorState({
  title = 'Error',
  message,
  onRetry,
  inline = false,
  className = ''
}) {
  const classes = [
    'ui-error',
    inline && 'ui-error-inline',
    className
  ].filter(Boolean).join(' ')

  return (
    <div className={classes}>
      <div className="ui-error-icon">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <div className="ui-error-content">
        {!inline && title && <h4 className="ui-error-title">{title}</h4>}
        {message && <p className="ui-error-message">{message}</p>}
      </div>
      {onRetry && (
        <Button variant="outline-red" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  )
}

/**
 * ErrorMessage - Simple inline error message
 */
export function ErrorMessage({ message, className = '' }) {
  return (
    <span
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--ui-space-2, 0.5rem)',
        fontSize: 'var(--ui-text-sm, 0.75rem)',
        color: 'var(--ui-red-light, #ff6060)'
      }}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      {message}
    </span>
  )
}

/**
 * NoData - Simple "no data" message
 */
export function NoData({ message = 'No data available', className = '' }) {
  return (
    <div
      className={className}
      style={{
        padding: 'var(--ui-space-8, 2rem)',
        textAlign: 'center',
        color: 'var(--ui-text-muted)',
        fontSize: 'var(--ui-text-sm, 0.75rem)'
      }}
    >
      {message}
    </div>
  )
}

/**
 * Common empty state presets
 */
export function EmptySearch({ query, onClear }) {
  return (
    <Empty
      icon={
        <svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" strokeWidth="1.5">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.35-4.35"/>
        </svg>
      }
      title="No results found"
      description={query ? `No results for "${query}"` : 'Try adjusting your search'}
    >
      {onClear && (
        <Button variant="secondary" size="sm" onClick={onClear}>
          Clear search
        </Button>
      )}
    </Empty>
  )
}

export function EmptyList({ itemName = 'items', onCreate }) {
  return (
    <Empty
      icon={
        <svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" strokeWidth="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M12 8v8m-4-4h8"/>
        </svg>
      }
      title={`No ${itemName} yet`}
      description={`Get started by creating your first ${itemName.slice(0, -1)}`}
    >
      {onCreate && (
        <Button variant="primary" onClick={onCreate}>
          Create {itemName.slice(0, -1)}
        </Button>
      )}
    </Empty>
  )
}

export function EmptyFolder({ onUpload }) {
  return (
    <Empty
      icon={
        <svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" strokeWidth="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      }
      title="No files"
      description="Upload files to get started"
    >
      {onUpload && (
        <Button variant="primary" onClick={onUpload}>
          Upload files
        </Button>
      )}
    </Empty>
  )
}

export function EmptyConnection() {
  return (
    <Empty
      icon={
        <svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" strokeWidth="1.5">
          <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.58 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>
        </svg>
      }
      title="No connection"
      description="Check your network connection and try again"
    />
  )
}

export default Empty
