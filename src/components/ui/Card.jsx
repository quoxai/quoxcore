/**
 * Card Component
 *
 * A flexible container component for grouping related content.
 * Supports headers, footers, and various interaction patterns.
 *
 * @example
 * // Basic card
 * <Card>
 *   <Card.Body>Content here</Card.Body>
 * </Card>
 *
 * // Card with header and footer
 * <Card>
 *   <Card.Header title="Settings" icon={<GearIcon />} />
 *   <Card.Body>Settings content</Card.Body>
 *   <Card.Footer>
 *     <Button variant="primary">Save</Button>
 *   </Card.Footer>
 * </Card>
 *
 * // Interactive card with accent
 * <Card interactive accent="blue" onClick={handleClick} selected={isSelected}>
 *   <Card.Body>Click me</Card.Body>
 * </Card>
 *
 * Props:
 * - interactive: boolean - Makes card clickable with hover states
 * - selected: boolean - Shows selected state styling
 * - accent: 'red' | 'blue' | 'green' | 'amber' | 'purple' - Accent color for hover
 * - className: string
 * - onClick: function (for interactive cards)
 */

import { forwardRef, createContext, useContext } from 'react'

const CardContext = createContext({ interactive: false })

const Card = forwardRef(function Card(
  {
    interactive = false,
    selected = false,
    accent,
    className = '',
    children,
    onClick,
    ...props
  },
  ref
) {
  const classes = [
    'ui-card',
    interactive && 'ui-card-interactive',
    selected && 'ui-card-selected',
    accent && `ui-card-accent-${accent}`,
    className
  ].filter(Boolean).join(' ')

  const Component = interactive ? 'button' : 'div'

  return (
    <CardContext.Provider value={{ interactive }}>
      <Component
        ref={ref}
        className={classes}
        onClick={interactive ? onClick : undefined}
        type={interactive ? 'button' : undefined}
        {...props}
      >
        {children}
      </Component>
    </CardContext.Provider>
  )
})

/**
 * Card.Header - Header section with title and optional actions
 */
function CardHeader({
  title,
  icon,
  actions,
  className = '',
  children,
  ...props
}) {
  return (
    <div className={`ui-card-header ${className}`} {...props}>
      {(title || icon) && (
        <h3 className="ui-card-title">
          {icon}
          {title}
        </h3>
      )}
      {children}
      {actions && <div className="ui-card-actions">{actions}</div>}
    </div>
  )
}

/**
 * Card.Body - Main content area
 */
function CardBody({ compact = false, noPadding = false, className = '', children, ...props }) {
  const classes = [
    'ui-card-body',
    compact && 'ui-card-body-compact',
    noPadding && 'ui-card-body-none',
    className
  ].filter(Boolean).join(' ')

  return (
    <div className={classes} {...props}>
      {children}
    </div>
  )
}

/**
 * Card.Footer - Footer section, typically for actions
 */
function CardFooter({ className = '', children, ...props }) {
  return (
    <div className={`ui-card-footer ${className}`} {...props}>
      {children}
    </div>
  )
}

// Attach sub-components
Card.Header = CardHeader
Card.Body = CardBody
Card.Footer = CardFooter

export default Card
