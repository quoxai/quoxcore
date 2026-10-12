/**
 * Button Component
 *
 * A flexible button component with multiple variants, sizes, and states.
 *
 * @example
 * // Primary button
 * <Button variant="primary">Submit</Button>
 *
 * // Outline button with icon
 * <Button variant="outline-red" icon={<TrashIcon />}>Delete</Button>
 *
 * // Icon-only button
 * <Button variant="ghost" iconOnly aria-label="Settings"><GearIcon /></Button>
 *
 * // Loading state
 * <Button loading>Processing...</Button>
 *
 * Props:
 * - variant: 'primary' | 'secondary' | 'ghost' | 'outline' | 'outline-red' | 'outline-green' | 'outline-blue' | 'outline-amber' | 'outline-purple' | 'danger' | 'success'
 * - size: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
 * - iconOnly: boolean - Makes button square for icon-only usage
 * - icon: ReactNode - Icon to display before children
 * - iconRight: ReactNode - Icon to display after children
 * - loading: boolean - Shows spinner and disables button
 * - disabled: boolean
 * - className: string - Additional CSS classes
 * - as: string | Component - Render as different element (e.g., 'a' for links)
 * - All other props passed to underlying element
 */

import { forwardRef } from 'react'

const Button = forwardRef(function Button(
  {
    variant = 'secondary',
    size = 'md',
    iconOnly = false,
    icon,
    iconRight,
    loading = false,
    disabled = false,
    className = '',
    children,
    as: Component = 'button',
    ...props
  },
  ref
) {
  // Build class names
  const classes = [
    'ui-btn',
    `ui-btn-${variant}`,
    size !== 'md' && `ui-btn-${size}`,
    iconOnly && 'ui-btn-icon',
    loading && 'ui-btn-loading',
    className
  ].filter(Boolean).join(' ')

  return (
    <Component
      ref={ref}
      className={classes}
      disabled={disabled || loading}
      {...props}
    >
      {icon && !loading && <span className="ui-btn-icon-left">{icon}</span>}
      {children}
      {iconRight && !loading && <span className="ui-btn-icon-right">{iconRight}</span>}
    </Component>
  )
})

export default Button

/**
 * IconButton - Convenience wrapper for icon-only buttons
 */
export function IconButton({ children, 'aria-label': ariaLabel, ...props }) {
  return (
    <Button iconOnly aria-label={ariaLabel} {...props}>
      {children}
    </Button>
  )
}

/**
 * ButtonGroup - Group of buttons with connected styling
 */
export function ButtonGroup({ children, className = '' }) {
  return (
    <div className={`ui-btn-group ${className}`} role="group">
      {children}
    </div>
  )
}
