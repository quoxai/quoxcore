/**
 * Badge Component
 *
 * Small labels for status, counts, and categorization.
 *
 * @example
 * // Basic badge
 * <Badge>Default</Badge>
 *
 * // Colored badges
 * <Badge color="green">Active</Badge>
 * <Badge color="red">Error</Badge>
 * <Badge color="amber">Warning</Badge>
 *
 * // Solid badges
 * <Badge color="red" solid>DANGER</Badge>
 *
 * // Pill shape
 * <Badge color="blue" pill>5 items</Badge>
 *
 * Props:
 * - color: 'default' | 'red' | 'green' | 'blue' | 'amber' | 'orange' | 'purple'
 * - solid: boolean - Use solid background instead of transparent
 * - pill: boolean - Use rounded pill shape
 * - icon: ReactNode - Icon to display before text
 * - className: string
 */

import { forwardRef } from 'react'

const Badge = forwardRef(function Badge(
  {
    color = 'default',
    solid = false,
    pill = false,
    icon,
    className = '',
    children,
    ...props
  },
  ref
) {
  const classes = [
    'ui-badge',
    solid ? `ui-badge-solid-${color}` : `ui-badge-${color}`,
    pill && 'ui-badge-pill',
    className
  ].filter(Boolean).join(' ')

  return (
    <span ref={ref} className={classes} {...props}>
      {icon}
      {children}
    </span>
  )
})

export default Badge

/**
 * StatusBadge - Pre-configured badges for common statuses
 */
export function StatusBadge({ status, className = '' }) {
  const config = {
    // Status states
    online: { color: 'green', label: 'Online' },
    offline: { color: 'default', label: 'Offline' },
    running: { color: 'green', label: 'Running' },
    stopped: { color: 'default', label: 'Stopped' },
    paused: { color: 'amber', label: 'Paused' },
    pending: { color: 'amber', label: 'Pending' },
    error: { color: 'red', label: 'Error' },
    success: { color: 'green', label: 'Success' },
    failed: { color: 'red', label: 'Failed' },
    warning: { color: 'amber', label: 'Warning' },
    active: { color: 'green', label: 'Active' },
    inactive: { color: 'default', label: 'Inactive' },
    connected: { color: 'green', label: 'Connected' },
    disconnected: { color: 'red', label: 'Disconnected' },
    healthy: { color: 'green', label: 'Healthy' },
    degraded: { color: 'amber', label: 'Degraded' },
    critical: { color: 'red', label: 'Critical' },
    maintenance: { color: 'amber', label: 'Maintenance' }
  }

  const { color = 'default', label = status } = config[status?.toLowerCase()] || {}

  return (
    <Badge color={color} className={className}>
      {label}
    </Badge>
  )
}

/**
 * CountBadge - Badge showing a count (for notifications, etc.)
 */
export function CountBadge({ count, max = 99, color = 'red', className = '' }) {
  if (!count || count <= 0) return null

  const displayCount = count > max ? `${max}+` : count

  return (
    <Badge color={color} solid pill className={className}>
      {displayCount}
    </Badge>
  )
}

/**
 * TypeBadge - Badge for categorizing types (VM, CT, Host, etc.)
 */
export function TypeBadge({ type, className = '' }) {
  const config = {
    vm: { color: 'blue', label: 'VM' },
    qemu: { color: 'blue', label: 'VM' },
    ct: { color: 'purple', label: 'CT' },
    lxc: { color: 'purple', label: 'CT' },
    container: { color: 'purple', label: 'CT' },
    host: { color: 'amber', label: 'HOST' },
    node: { color: 'amber', label: 'NODE' },
    agent: { color: 'green', label: 'AGENT' }
  }

  const { color = 'default', label = type?.toUpperCase() || 'UNKNOWN' } = config[type?.toLowerCase()] || {}

  return (
    <Badge color={color} className={className}>
      {label}
    </Badge>
  )
}

/**
 * SeverityBadge - For DEFCON levels, alert severity, etc.
 */
export function SeverityBadge({ level, className = '' }) {
  const config = {
    green: { color: 'green', label: 'GREEN' },
    blue: { color: 'blue', label: 'BLUE' },
    amber: { color: 'amber', label: 'AMBER' },
    orange: { color: 'orange', label: 'ORANGE' },
    red: { color: 'red', label: 'RED', solid: true },
    low: { color: 'green', label: 'LOW' },
    medium: { color: 'amber', label: 'MEDIUM' },
    high: { color: 'orange', label: 'HIGH' },
    critical: { color: 'red', label: 'CRITICAL', solid: true }
  }

  const { color = 'default', label = level?.toUpperCase() || 'UNKNOWN', solid = false } = config[level?.toLowerCase()] || {}

  return (
    <Badge color={color} solid={solid} className={className}>
      {label}
    </Badge>
  )
}
