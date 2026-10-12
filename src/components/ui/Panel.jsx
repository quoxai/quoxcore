/**
 * Panel Component
 *
 * A monitoring-style panel component with header, actions, and scrollable body.
 * Used for dashboard sections like ProxmoxPanel, MetricsPanel, etc.
 *
 * @example
 * <Panel accent="blue">
 *   <Panel.Header
 *     title="Metrics"
 *     icon={<ChartIcon />}
 *     actions={<RefreshButton />}
 *   />
 *   <Panel.Body>
 *     <MetricsList />
 *   </Panel.Body>
 * </Panel>
 *
 * Props:
 * - accent: 'red' | 'blue' | 'green' | 'orange' | 'purple' - Title icon color
 * - className: string
 */

import { forwardRef, createContext, useContext } from 'react'

const PanelContext = createContext({ accent: null })

const Panel = forwardRef(function Panel(
  { accent, className = '', children, ...props },
  ref
) {
  const classes = [
    'ui-panel',
    accent && `ui-panel-${accent}`,
    className
  ].filter(Boolean).join(' ')

  return (
    <PanelContext.Provider value={{ accent }}>
      <div ref={ref} className={classes} {...props}>
        {children}
      </div>
    </PanelContext.Provider>
  )
})

/**
 * Panel.Header - Header with title, icon, and actions
 */
function PanelHeader({
  title,
  icon,
  actions,
  badge,
  timestamp,
  className = '',
  children,
  ...props
}) {
  return (
    <div className={`ui-panel-header ${className}`} {...props}>
      <h3 className="ui-panel-title">
        {icon}
        <span>{title}</span>
        {badge}
      </h3>
      <div className="ui-panel-actions">
        {timestamp && (
          <span className="ui-panel-timestamp">{timestamp}</span>
        )}
        {actions}
        {children}
      </div>
    </div>
  )
}

/**
 * Panel.Body - Scrollable content area
 */
function PanelBody({ className = '', children, ...props }) {
  return (
    <div className={`ui-panel-body ${className}`} {...props}>
      {children}
    </div>
  )
}

/**
 * RefreshButton - Common refresh action for panels
 */
export function RefreshButton({ onClick, loading = false, className = '' }) {
  return (
    <button
      className={`ui-btn ui-btn-ghost ui-btn-icon ui-btn-sm ${loading ? 'ui-btn-loading' : ''} ${className}`}
      onClick={onClick}
      disabled={loading}
      title="Refresh"
      aria-label="Refresh"
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={loading ? 'ui-spinning' : ''}
      >
        <path d="M21 12a9 9 0 11-6.22-8.56"/>
        <path d="M21 3v6h-6"/>
      </svg>
    </button>
  )
}

// Add spinning animation to CSS
const spinningStyle = `
.ui-spinning {
  animation: ui-spin 1s linear infinite;
}
`

// Attach sub-components
Panel.Header = PanelHeader
Panel.Body = PanelBody

export default Panel
