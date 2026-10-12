/**
 * Collapsible Component
 *
 * Expandable/collapsible content sections with smooth animations.
 * Can persist state to localStorage if given a unique key.
 *
 * @example
 * // Basic collapsible
 * <Collapsible title="Details">
 *   <p>Hidden content here</p>
 * </Collapsible>
 *
 * // With icon and badge
 * <Collapsible
 *   title="Alerts"
 *   icon={<AlertIcon />}
 *   badge={<Badge color="red">5</Badge>}
 *   defaultOpen={true}
 * >
 *   <AlertList />
 * </Collapsible>
 *
 * // Persisted state
 * <Collapsible
 *   title="Settings"
 *   persistKey="settings-section"
 * >
 *   <SettingsForm />
 * </Collapsible>
 *
 * Props:
 * - title: string | ReactNode - Header title
 * - icon: ReactNode - Icon to display in header
 * - badge: ReactNode - Badge/count to display in header
 * - defaultOpen: boolean - Initial open state (default: true)
 * - persistKey: string - localStorage key for persisting state
 * - onToggle: function(isOpen) - Callback when toggled
 * - disabled: boolean - Prevent toggling
 * - headerActions: ReactNode - Additional actions in header
 * - className: string
 */

import { useState, useEffect, useRef, useCallback } from 'react'

export default function Collapsible({
  title,
  icon,
  badge,
  defaultOpen = true,
  persistKey,
  onToggle,
  disabled = false,
  headerActions,
  className = '',
  children
}) {
  // Initialize state from localStorage if persistKey provided
  const getInitialState = () => {
    if (persistKey) {
      const stored = localStorage.getItem(`collapsible:${persistKey}`)
      if (stored !== null) {
        return stored === 'true'
      }
    }
    return defaultOpen
  }

  const [isOpen, setIsOpen] = useState(getInitialState)
  const contentRef = useRef(null)
  const [contentHeight, setContentHeight] = useState(isOpen ? 'auto' : 0)

  // Update content height when toggling
  useEffect(() => {
    if (!contentRef.current) return

    if (isOpen) {
      // Set to actual height first for animation
      const height = contentRef.current.scrollHeight
      setContentHeight(height)
      // Then set to auto after animation
      const timer = setTimeout(() => {
        setContentHeight('auto')
      }, 300)
      return () => clearTimeout(timer)
    } else {
      // Set explicit height first
      setContentHeight(contentRef.current.scrollHeight)
      // Then animate to 0
      requestAnimationFrame(() => {
        setContentHeight(0)
      })
    }
  }, [isOpen])

  // Persist state to localStorage
  useEffect(() => {
    if (persistKey) {
      localStorage.setItem(`collapsible:${persistKey}`, String(isOpen))
    }
  }, [isOpen, persistKey])

  const toggle = useCallback(() => {
    if (disabled) return
    setIsOpen(prev => {
      const next = !prev
      onToggle?.(next)
      return next
    })
  }, [disabled, onToggle])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  }

  return (
    <div className={`ui-collapsible ${isOpen ? '' : 'ui-collapsible-collapsed'} ${className}`}>
      {/* Header */}
      <div
        className="ui-collapsible-header"
        onClick={toggle}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-expanded={isOpen}
        aria-disabled={disabled}
      >
        <div className="ui-collapsible-header-left">
          <span className="ui-collapsible-title">
            {icon}
            {title}
          </span>
          {badge}
        </div>
        <div className="ui-collapsible-header-right">
          {headerActions}
          <span className="ui-collapsible-toggle" aria-hidden="true">
            <ChevronIcon />
          </span>
        </div>
      </div>

      {/* Content */}
      <div
        ref={contentRef}
        className="ui-collapsible-content"
        style={{
          maxHeight: typeof contentHeight === 'number' ? `${contentHeight}px` : contentHeight,
          overflow: 'hidden',
          transition: 'max-height 0.3s ease, opacity 0.2s ease',
          opacity: isOpen ? 1 : 0
        }}
        aria-hidden={!isOpen}
      >
        <div className="ui-collapsible-inner">
          {children}
        </div>
      </div>
    </div>
  )
}

/**
 * Chevron icon for toggle indicator
 */
function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transition: 'transform 0.2s ease'
      }}
    >
      <path d="M6 9l6 6 6-6"/>
    </svg>
  )
}

/**
 * CollapsibleGroup - Group of collapsibles with accordion behavior (optional)
 *
 * Props:
 * - accordion: boolean - Only allow one open at a time
 * - children: Collapsible components
 */
export function CollapsibleGroup({
  accordion = false,
  defaultOpenIndex = 0,
  className = '',
  children
}) {
  const [openIndex, setOpenIndex] = useState(accordion ? defaultOpenIndex : null)

  if (!accordion) {
    return <div className={`ui-collapsible-group ${className}`}>{children}</div>
  }

  // Clone children with accordion behavior
  const items = Array.isArray(children) ? children : [children]

  return (
    <div className={`ui-collapsible-group ${className}`}>
      {items.map((child, index) => {
        if (!child?.type === Collapsible) return child

        return (
          <Collapsible
            key={index}
            {...child.props}
            defaultOpen={index === openIndex}
            onToggle={(isOpen) => {
              if (isOpen) {
                setOpenIndex(index)
              }
              child.props.onToggle?.(isOpen)
            }}
          />
        )
      })}
    </div>
  )
}

/**
 * useCollapsible - Hook for controlled collapsible state
 */
export function useCollapsible(defaultOpen = true, persistKey) {
  const [isOpen, setIsOpen] = useState(() => {
    if (persistKey) {
      const stored = localStorage.getItem(`collapsible:${persistKey}`)
      if (stored !== null) return stored === 'true'
    }
    return defaultOpen
  })

  useEffect(() => {
    if (persistKey) {
      localStorage.setItem(`collapsible:${persistKey}`, String(isOpen))
    }
  }, [isOpen, persistKey])

  const toggle = useCallback(() => setIsOpen(prev => !prev), [])
  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])

  return { isOpen, toggle, open, close, setIsOpen }
}

// CSS for Collapsible (add to ui.css)
const collapsibleStyles = `
.ui-collapsible {
  display: flex;
  flex-direction: column;
  background: var(--ui-surface);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-lg);
  overflow: hidden;
}

.ui-collapsible-collapsed {
  flex-shrink: 0;
}

.ui-collapsible-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--ui-space-3) var(--ui-space-4);
  background: rgba(255, 255, 255, 0.02);
  cursor: pointer;
  user-select: none;
  transition: background var(--ui-transition-fast);
}

.ui-collapsible-header:hover {
  background: rgba(255, 255, 255, 0.05);
}

.ui-collapsible-header:focus-visible {
  outline: 2px solid var(--ui-blue);
  outline-offset: -2px;
}

.ui-collapsible-header-left {
  display: flex;
  align-items: center;
  gap: var(--ui-space-3);
}

.ui-collapsible-header-right {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
}

.ui-collapsible-title {
  font-size: var(--ui-text-base);
  font-weight: 600;
  color: var(--ui-text-primary);
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
}

.ui-collapsible-title svg {
  opacity: 0.7;
}

.ui-collapsible-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--ui-radius-sm);
  background: rgba(255, 255, 255, 0.05);
  color: var(--ui-text-muted);
  transition: all var(--ui-transition-normal);
}

.ui-collapsible-header:hover .ui-collapsible-toggle {
  background: rgba(255, 255, 255, 0.1);
  color: var(--ui-text-secondary);
}

.ui-collapsible-collapsed .ui-collapsible-toggle svg {
  transform: rotate(-90deg);
}

.ui-collapsible-inner {
  padding: var(--ui-space-4);
}

.ui-collapsible-group {
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-3);
}
`
