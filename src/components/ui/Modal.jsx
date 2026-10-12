/**
 * Modal Component
 *
 * A flexible modal/dialog component with overlay, header, body, and footer.
 * Supports various severity levels (danger, warning, info) and accessibility features.
 *
 * @example
 * // Basic modal
 * <Modal isOpen={isOpen} onClose={handleClose}>
 *   <Modal.Header title="Confirm Action" />
 *   <Modal.Body>Are you sure?</Modal.Body>
 *   <Modal.Footer>
 *     <Button variant="secondary" onClick={handleClose}>Cancel</Button>
 *     <Button variant="primary" onClick={handleConfirm}>Confirm</Button>
 *   </Modal.Footer>
 * </Modal>
 *
 * // Danger modal (for destructive actions)
 * <Modal isOpen={isOpen} onClose={handleClose} severity="danger">
 *   <Modal.Header title="Delete Item" badge="DANGER" />
 *   <Modal.Body>This cannot be undone!</Modal.Body>
 *   <Modal.Footer>
 *     <Button variant="secondary" onClick={handleClose}>Cancel</Button>
 *     <Button variant="danger" onClick={handleDelete}>Delete</Button>
 *   </Modal.Footer>
 * </Modal>
 *
 * Props:
 * - isOpen: boolean - Controls visibility
 * - onClose: function - Called when modal should close (overlay click, escape key)
 * - severity: 'default' | 'danger' | 'warning' | 'info' - Visual style
 * - size: 'sm' | 'md' | 'lg' | 'xl' | 'full' - Modal width
 * - closeOnOverlay: boolean - Whether clicking overlay closes modal (default: true)
 * - closeOnEscape: boolean - Whether Escape key closes modal (default: true)
 */

import { useEffect, useRef, useCallback, createContext, useContext } from 'react'
import { createPortal } from 'react-dom'

const ModalContext = createContext({ severity: 'default' })

// Severity color mapping
const SEVERITY_COLORS = {
  default: 'rgba(255, 255, 255, 0.1)',
  danger: 'rgba(255, 48, 48, 0.1)',
  warning: 'rgba(255, 176, 48, 0.1)',
  info: 'rgba(48, 144, 255, 0.1)'
}

const SEVERITY_BORDER_COLORS = {
  default: 'rgba(255, 255, 255, 0.1)',
  danger: 'rgba(255, 48, 48, 0.3)',
  warning: 'rgba(255, 176, 48, 0.3)',
  info: 'rgba(48, 144, 255, 0.3)'
}

const SIZE_WIDTHS = {
  sm: '400px',
  md: '520px',
  lg: '680px',
  xl: '840px',
  full: '95vw'
}

export default function Modal({
  isOpen,
  onClose,
  severity = 'default',
  size = 'md',
  closeOnOverlay = true,
  closeOnEscape = true,
  className = '',
  children
}) {
  const modalRef = useRef(null)

  // Handle Escape key
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose?.()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, closeOnEscape, onClose])

  // Prevent body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  // Focus trap - focus first focusable element
  useEffect(() => {
    if (isOpen && modalRef.current) {
      const focusable = modalRef.current.querySelector(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      focusable?.focus()
    }
  }, [isOpen])

  const handleOverlayClick = useCallback((e) => {
    if (closeOnOverlay && e.target === e.currentTarget) {
      onClose?.()
    }
  }, [closeOnOverlay, onClose])

  if (!isOpen) return null

  const modalContent = (
    <ModalContext.Provider value={{ severity }}>
      <div
        className={`ui-modal-overlay ${severity !== 'default' ? `ui-modal-overlay-${severity}` : ''}`}
        onClick={handleOverlayClick}
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed',
          inset: 0,
          background: severity === 'danger'
            ? 'rgba(255, 48, 48, 0.12)'
            : severity === 'warning'
            ? 'rgba(255, 176, 48, 0.08)'
            : 'rgba(0, 0, 0, 0.45)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 'var(--ui-z-modal, 1000)',
          backdropFilter: 'var(--glass-blur)',
          WebkitBackdropFilter: 'var(--glass-blur)'
        }}
      >
        <div
          ref={modalRef}
          className={`ui-modal glass ${className}`}
          style={{
            width: '100%',
            maxWidth: SIZE_WIDTHS[size],
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
            ...(severity === 'danger' && {
              boxShadow: '0 0 60px rgba(255, 48, 48, 0.3), var(--glass-shadow)',
              borderTopColor: SEVERITY_BORDER_COLORS.danger
            }),
            ...(severity === 'warning' && {
              boxShadow: '0 0 50px rgba(255, 176, 48, 0.2), var(--glass-shadow)',
              borderTopColor: SEVERITY_BORDER_COLORS.warning
            }),
            ...(severity === 'info' && {
              boxShadow: '0 0 50px rgba(48, 144, 255, 0.2), var(--glass-shadow)',
              borderTopColor: SEVERITY_BORDER_COLORS.info
            }),
            animation: 'ui-modal-appear 0.2s ease-out'
          }}
        >
          {children}
        </div>
      </div>
    </ModalContext.Provider>
  )

  // Render into portal for proper stacking
  return createPortal(modalContent, document.body)
}

/**
 * Modal.Header - Header with title, icon, and optional badge
 */
function ModalHeader({
  title,
  description,
  icon,
  badge,
  onClose,
  className = '',
  children,
  ...props
}) {
  const { severity } = useContext(ModalContext)

  const headerBg = SEVERITY_COLORS[severity]
  const headerBorder = SEVERITY_BORDER_COLORS[severity]

  return (
    <div
      className={`ui-modal-header ${className}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--ui-space-3, 0.75rem)',
        padding: 'var(--ui-space-4, 1rem) var(--ui-space-5, 1.25rem)',
        background: headerBg,
        borderBottom: `1px solid ${headerBorder}`
      }}
      {...props}
    >
      {icon && (
        <div
          className="ui-modal-icon"
          style={{
            width: '36px',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: severity === 'danger'
              ? 'rgba(255, 48, 48, 0.2)'
              : severity === 'warning'
              ? 'rgba(255, 176, 48, 0.2)'
              : 'rgba(255, 255, 255, 0.05)',
            borderRadius: 'var(--ui-radius-lg, 8px)',
            color: severity === 'danger'
              ? 'var(--ui-red-light, #ff6060)'
              : severity === 'warning'
              ? 'var(--ui-amber, #ffb030)'
              : 'var(--ui-text-secondary)'
          }}
        >
          {icon}
        </div>
      )}
      <div style={{ flex: 1 }}>
        {title && (
          <h2
            style={{
              margin: 0,
              fontSize: 'var(--ui-text-lg, 1rem)',
              fontWeight: 600,
              color: 'var(--ui-text-primary, white)'
            }}
          >
            {title}
          </h2>
        )}
        {description && (
          <p
            style={{
              margin: '2px 0 0',
              fontSize: 'var(--ui-text-sm, 0.75rem)',
              color: 'var(--ui-text-muted, #999)'
            }}
          >
            {description}
          </p>
        )}
      </div>
      {badge && (
        <span
          className="ui-modal-badge"
          style={{
            padding: '4px 10px',
            background: severity === 'danger'
              ? 'var(--ui-red, #38bdf8)'
              : severity === 'warning'
              ? 'var(--ui-amber, #ffb030)'
              : 'rgba(255, 255, 255, 0.1)',
            borderRadius: 'var(--ui-radius-sm, 4px)',
            fontSize: 'var(--ui-text-xs, 0.65rem)',
            fontWeight: 700,
            color: severity === 'danger' || severity === 'warning' ? 'white' : 'var(--ui-text-secondary)',
            letterSpacing: '1px'
          }}
        >
          {badge}
        </span>
      )}
      {onClose && (
        <button
          onClick={onClose}
          className="ui-modal-close"
          aria-label="Close"
          style={{
            width: '32px',
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: '1px solid var(--ui-border, rgba(255, 255, 255, 0.1))',
            borderRadius: 'var(--ui-radius-md, 6px)',
            color: 'var(--ui-text-muted)',
            cursor: 'pointer',
            fontSize: '1.25rem'
          }}
        >
          &times;
        </button>
      )}
      {children}
    </div>
  )
}

/**
 * Modal.Body - Main content area
 */
function ModalBody({ className = '', children, ...props }) {
  return (
    <div
      className={`ui-modal-body ${className}`}
      style={{
        padding: 'var(--ui-space-5, 1.25rem)',
        overflowY: 'auto',
        flex: 1
      }}
      {...props}
    >
      {children}
    </div>
  )
}

/**
 * Modal.Footer - Footer area, typically for action buttons
 */
function ModalFooter({ className = '', children, ...props }) {
  return (
    <div
      className={`ui-modal-footer ${className}`}
      style={{
        display: 'flex',
        gap: 'var(--ui-space-3, 0.75rem)',
        padding: 'var(--ui-space-4, 1rem) var(--ui-space-5, 1.25rem)',
        background: 'rgba(0, 0, 0, 0.2)',
        borderTop: '1px solid var(--ui-border, rgba(255, 255, 255, 0.05))'
      }}
      {...props}
    >
      {children}
    </div>
  )
}

// Add keyframes animation
const modalStyles = `
@keyframes ui-modal-appear {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
`

// Attach sub-components
Modal.Header = ModalHeader
Modal.Body = ModalBody
Modal.Footer = ModalFooter
