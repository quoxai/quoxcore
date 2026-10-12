/**
 * CommandValidationModal - Modal for command validation results
 *
 * Shows when a command is blocked, requires warning confirmation, or requires approval.
 * Displays command details, target host, severity, and appropriate action buttons.
 */

import Modal from '../ui/Modal'
import Button from '../ui/Button'
import { getSeverityColor } from '../../config/denylist'

// Map validation action to modal configuration
const ACTION_CONFIG = {
  BLOCK: {
    title: 'Command Blocked',
    modalSeverity: 'danger',
    badge: 'BLOCKED',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>
      </svg>
    )
  },
  WARN: {
    title: 'Warning',
    modalSeverity: 'warning',
    badge: 'WARNING',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
    )
  },
  REQUIRE_APPROVAL: {
    title: 'Approval Required',
    modalSeverity: 'warning',
    badge: 'APPROVAL',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    )
  },
  REQUIRE_OVERRIDE: {
    title: 'Override Required',
    modalSeverity: 'danger',
    badge: 'OVERRIDE',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
      </svg>
    )
  }
}

export function CommandValidationModal({
  isOpen,
  onClose,
  validation,
  command,
  hostName,
  onConfirm,
  onRequestApproval
}) {
  if (!validation) return null

  const action = validation.action || 'BLOCK'
  const config = ACTION_CONFIG[action] || ACTION_CONFIG.BLOCK
  const severityColor = getSeverityColor(validation.severity)

  const handleAction = () => {
    if (action === 'WARN') {
      onConfirm?.()
    } else if (action === 'REQUIRE_APPROVAL' || action === 'REQUIRE_OVERRIDE') {
      onRequestApproval?.()
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      severity={config.modalSeverity}
      size="md"
    >
      <Modal.Header
        title={config.title}
        description="Command validation result"
        icon={config.icon}
        badge={config.badge}
        onClose={onClose}
      />

      <Modal.Body>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Command Display */}
          <div style={{
            padding: '0.875rem 1rem',
            background: 'rgba(0, 0, 0, 0.3)',
            borderRadius: '8px',
            border: '1px solid rgba(255, 255, 255, 0.06)'
          }}>
            <div style={{
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              color: 'var(--ui-text-muted, #666)',
              marginBottom: '0.375rem'
            }}>
              Command
            </div>
            <code style={{
              display: 'block',
              fontSize: '0.85rem',
              color: severityColor,
              fontFamily: 'monospace',
              wordBreak: 'break-all',
              whiteSpace: 'pre-wrap'
            }}>
              {command}
            </code>
          </div>

          {/* Target Host */}
          <div style={{
            padding: '0.75rem 1rem',
            background: 'rgba(255, 255, 255, 0.03)',
            borderRadius: '8px',
            border: '1px solid rgba(255, 255, 255, 0.06)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem'
          }}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="var(--ui-text-muted, #666)">
              <path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>
            </svg>
            <div>
              <div style={{
                fontSize: '0.7rem',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                color: 'var(--ui-text-muted, #666)',
                marginBottom: '0.125rem'
              }}>
                Target Host
              </div>
              <div style={{
                fontSize: '0.875rem',
                color: 'var(--ui-text-primary, white)',
                fontWeight: 500
              }}>
                {hostName || 'Unknown'}
              </div>
            </div>
          </div>

          {/* Reason/Description */}
          <div style={{
            padding: '0.75rem 1rem',
            background: config.modalSeverity === 'danger'
              ? 'rgba(255, 48, 48, 0.1)'
              : 'rgba(255, 176, 48, 0.1)',
            borderRadius: '8px',
            borderLeft: `3px solid ${severityColor}`,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem'
          }}>
            <div style={{
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              color: 'var(--ui-text-muted, #666)'
            }}>
              Reason
            </div>
            <div style={{
              fontSize: '0.875rem',
              color: 'var(--ui-text-primary, white)',
              lineHeight: 1.5
            }}>
              {validation.description || 'This command has been flagged for review.'}
            </div>
          </div>

          {/* Severity Badge */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <span style={{
              fontSize: '0.7rem',
              color: 'var(--ui-text-muted, #666)',
              textTransform: 'uppercase',
              letterSpacing: '0.5px'
            }}>
              Severity:
            </span>
            <span style={{
              padding: '4px 10px',
              background: severityColor,
              borderRadius: '4px',
              fontSize: '0.65rem',
              fontWeight: 700,
              color: 'white',
              letterSpacing: '1px',
              textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)'
            }}>
              {validation.severity || 'UNKNOWN'}
            </span>
          </div>

          {/* Auth Required Notice */}
          {validation.requiresAuth && (
            <div style={{
              padding: '0.5rem 0.75rem',
              background: 'rgba(255, 255, 255, 0.03)',
              borderRadius: '6px',
              fontSize: '0.75rem',
              color: 'var(--ui-text-muted, #666)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
              </svg>
              This action requires authorization code
            </div>
          )}
        </div>
      </Modal.Body>

      <Modal.Footer>
        {action === 'BLOCK' ? (
          /* BLOCK: Just Close button */
          <Button
            variant="secondary"
            onClick={onClose}
            icon={
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            }
          >
            Close
          </Button>
        ) : action === 'WARN' ? (
          /* WARN: Cancel and Proceed Anyway */
          <>
            <Button
              variant="secondary"
              onClick={onClose}
              icon={
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              }
            >
              Cancel
            </Button>
            <Button
              variant="outline-amber"
              onClick={handleAction}
              icon={
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
              }
            >
              Proceed Anyway
            </Button>
          </>
        ) : (
          /* REQUIRE_APPROVAL / REQUIRE_OVERRIDE: Cancel and Request Approval */
          <>
            <Button
              variant="secondary"
              onClick={onClose}
              icon={
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              }
            >
              Cancel
            </Button>
            <Button
              variant={action === 'REQUIRE_OVERRIDE' ? 'danger' : 'primary'}
              onClick={handleAction}
              icon={
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
              }
            >
              Request Approval
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  )
}

export default CommandValidationModal
