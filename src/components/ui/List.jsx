/**
 * List Components
 *
 * Standardized list items and table-like displays.
 *
 * @example
 * // Basic list
 * <List>
 *   <ListItem title="Item 1" description="Description" />
 *   <ListItem title="Item 2" icon={<UserIcon />} />
 * </List>
 *
 * // Selectable list
 * <List>
 *   <ListItem
 *     title="Server 1"
 *     selected={selectedId === 1}
 *     onClick={() => setSelectedId(1)}
 *   />
 * </List>
 *
 * // List with accents
 * <ListItem accent="green" title="Online" />
 * <ListItem accent="red" title="Offline" />
 */

import { forwardRef } from 'react'

/**
 * List - Container for list items
 *
 * Props:
 * - divided: boolean - Show dividers between items
 * - compact: boolean - Reduce spacing
 * - className: string
 */
export function List({
  divided = false,
  compact = false,
  className = '',
  children
}) {
  return (
    <div
      className={`ui-list ${className}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 'var(--ui-space-1)' : 'var(--ui-space-2)'
      }}
      role="list"
    >
      {children}
    </div>
  )
}

/**
 * ListItem - Individual list item
 *
 * Props:
 * - title: string | ReactNode - Main text
 * - description: string | ReactNode - Secondary text
 * - icon: ReactNode - Left icon
 * - avatar: ReactNode - Left avatar/image
 * - accent: 'green' | 'red' | 'blue' | 'amber' | 'purple' - Left border color
 * - actions: ReactNode - Right-side actions
 * - selected: boolean - Selected state
 * - onClick: function - Make item interactive
 * - disabled: boolean
 * - meta: ReactNode - Additional metadata (right side)
 * - className: string
 */
export const ListItem = forwardRef(function ListItem(
  {
    title,
    description,
    icon,
    avatar,
    accent,
    actions,
    selected = false,
    onClick,
    disabled = false,
    meta,
    className = '',
    children,
    ...props
  },
  ref
) {
  const isInteractive = !!onClick && !disabled

  const classes = [
    'ui-list-item',
    isInteractive && 'ui-list-item-interactive',
    selected && 'ui-list-item-selected',
    accent && 'ui-list-item-accent',
    accent && `ui-list-item-accent-${accent}`,
    disabled && 'ui-list-item-disabled',
    className
  ].filter(Boolean).join(' ')

  const handleClick = () => {
    if (isInteractive) {
      onClick()
    }
  }

  const handleKeyDown = (e) => {
    if (isInteractive && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      onClick()
    }
  }

  return (
    <div
      ref={ref}
      className={classes}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role={isInteractive ? 'button' : 'listitem'}
      tabIndex={isInteractive ? 0 : undefined}
      style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
      {...props}
    >
      {/* Left side - icon or avatar */}
      {(icon || avatar) && (
        <div className="ui-list-item-leading">
          {avatar || icon}
        </div>
      )}

      {/* Content */}
      <div className="ui-list-item-content">
        {title && <div className="ui-list-item-title">{title}</div>}
        {description && <div className="ui-list-item-description">{description}</div>}
        {children}
      </div>

      {/* Right side - meta and actions */}
      {(meta || actions) && (
        <div className="ui-list-item-actions">
          {meta}
          {actions}
        </div>
      )}
    </div>
  )
})

/**
 * DataRow - Key-value display row
 *
 * @example
 * <DataRow label="Status" value="Running" />
 * <DataRow label="CPU" value="45%" valueColor="amber" />
 */
export function DataRow({
  label,
  value,
  valueColor,
  mono = false,
  className = ''
}) {
  return (
    <div
      className={`ui-data-row ${className}`}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 'var(--ui-space-2) 0',
        borderBottom: '1px solid var(--ui-border)'
      }}
    >
      <span style={{
        fontSize: 'var(--ui-text-sm)',
        color: 'var(--ui-text-muted)'
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 'var(--ui-text-sm)',
        fontFamily: mono ? 'var(--ui-font-mono)' : undefined,
        color: valueColor ? `var(--ui-${valueColor})` : 'var(--ui-text-primary)'
      }}>
        {value}
      </span>
    </div>
  )
}

/**
 * DataGrid - Grid of key-value pairs
 *
 * @example
 * <DataGrid
 *   data={[
 *     { label: 'Name', value: 'server-01' },
 *     { label: 'IP', value: '192.168.1.1', mono: true },
 *     { label: 'Status', value: 'Running', valueColor: 'green' },
 *   ]}
 * />
 */
export function DataGrid({
  data,
  columns = 2,
  className = ''
}) {
  return (
    <div
      className={`ui-data-grid ${className}`}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: 'var(--ui-space-3)'
      }}
    >
      {data.map((item, index) => (
        <div key={index} className="ui-data-item" style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--ui-space-1)'
        }}>
          <span style={{
            fontSize: 'var(--ui-text-xs)',
            color: 'var(--ui-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.03em'
          }}>
            {item.label}
          </span>
          <span style={{
            fontSize: 'var(--ui-text-sm)',
            fontFamily: item.mono ? 'var(--ui-font-mono)' : undefined,
            color: item.valueColor ? `var(--ui-${item.valueColor})` : 'var(--ui-text-primary)'
          }}>
            {item.value}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Table - Basic table component
 *
 * @example
 * <Table>
 *   <TableHeader>
 *     <TableCell>Name</TableCell>
 *     <TableCell>Status</TableCell>
 *   </TableHeader>
 *   <TableBody>
 *     <TableRow>
 *       <TableCell>Server 1</TableCell>
 *       <TableCell>Running</TableCell>
 *     </TableRow>
 *   </TableBody>
 * </Table>
 */
export function Table({ className = '', children }) {
  return (
    <div className={`ui-table ${className}`} style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        {children}
      </table>
    </div>
  )
}

export function TableHeader({ children }) {
  return (
    <thead>
      <tr style={{
        borderBottom: '1px solid var(--ui-border)'
      }}>
        {children}
      </tr>
    </thead>
  )
}

export function TableBody({ children }) {
  return <tbody>{children}</tbody>
}

export function TableRow({ selected = false, onClick, className = '', children }) {
  return (
    <tr
      className={className}
      onClick={onClick}
      style={{
        borderBottom: '1px solid var(--ui-border)',
        background: selected ? 'rgba(48, 144, 255, 0.1)' : undefined,
        cursor: onClick ? 'pointer' : undefined
      }}
    >
      {children}
    </tr>
  )
}

export function TableCell({ header = false, align = 'left', mono = false, className = '', children }) {
  const Component = header ? 'th' : 'td'

  return (
    <Component
      className={className}
      style={{
        padding: 'var(--ui-space-3) var(--ui-space-4)',
        textAlign: align,
        fontSize: header ? 'var(--ui-text-xs)' : 'var(--ui-text-sm)',
        fontWeight: header ? 600 : undefined,
        fontFamily: mono ? 'var(--ui-font-mono)' : undefined,
        color: header ? 'var(--ui-text-muted)' : 'var(--ui-text-primary)',
        textTransform: header ? 'uppercase' : undefined,
        letterSpacing: header ? '0.05em' : undefined
      }}
    >
      {children}
    </Component>
  )
}

export default List
