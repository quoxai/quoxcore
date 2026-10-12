/**
 * ActionConfirmationModal - Simple confirmation for SOC/NOC actions
 *
 * Shows action details and requires explicit user confirmation before execution.
 * Supports severity levels for visual distinction.
 */

import Modal from '../ui/Modal'
import Button from '../ui/Button'

const SEVERITY_INFO = {
  info: {
    badge: 'INFO',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
    )
  },
  warning: {
    badge: 'WARNING',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
    )
  },
  danger: {
    badge: 'CAUTION',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
    )
  }
}

export function ActionConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  action,
  loading = false
}) {
  if (!action) return null

  const severity = action.severity || 'info'
  const severityInfo = SEVERITY_INFO[severity] || SEVERITY_INFO.info

  const handleConfirm = () => {
    onConfirm(action)
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      severity={severity === 'danger' ? 'warning' : severity === 'warning' ? 'warning' : 'default'}
      size="sm"
      closeOnOverlay={!loading}
      closeOnEscape={!loading}
    >
      <Modal.Header
        title={action.label}
        description="Confirm action execution"
        icon={severityInfo.icon}
        badge={severityInfo.badge}
        onClose={!loading ? onClose : undefined}
      />

      <Modal.Body>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Action Description */}
          <div style={{
            padding: '0.875rem 1rem',
            background: 'rgba(255, 255, 255, 0.03)',
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
              This action will
            </div>
            <div style={{
              fontSize: '0.875rem',
              color: 'var(--ui-text-primary, white)',
              lineHeight: 1.5
            }}>
              {action.description || action.prompt}
            </div>
          </div>

          {/* Warning Message */}
          {action.confirmMessage && (
            <div style={{
              padding: '0.75rem 1rem',
              background: severity === 'danger'
                ? 'rgba(255, 48, 48, 0.1)'
                : severity === 'warning'
                ? 'rgba(255, 176, 48, 0.1)'
                : 'rgba(48, 144, 255, 0.1)',
              borderRadius: '8px',
              borderLeft: `3px solid ${
                severity === 'danger'
                  ? 'var(--ui-red, #ff3030)'
                  : severity === 'warning'
                  ? 'var(--ui-amber, #ffb030)'
                  : 'var(--ui-blue, #3090ff)'
              }`,
              fontSize: '0.8rem',
              color: 'var(--ui-text-secondary, #ccc)',
              lineHeight: 1.5
            }}>
              {action.confirmMessage}
            </div>
          )}

          {/* Backend Requirement Notice */}
          {action.requiresBackend && !action.enabled && (
            <div style={{
              padding: '0.5rem 0.75rem',
              background: 'rgba(255, 255, 255, 0.03)',
              borderRadius: '6px',
              fontSize: '0.7rem',
              color: 'var(--ui-text-muted, #666)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              <span style={{ opacity: 0.6 }}>Requires:</span>
              <code style={{
                padding: '0.125rem 0.375rem',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '3px',
                fontFamily: 'monospace',
                fontSize: '0.65rem'
              }}>
                {action.requiresBackend}
              </code>
            </div>
          )}
        </div>
      </Modal.Body>

      <Modal.Footer>
        <Button
          variant="secondary"
          onClick={onClose}
          disabled={loading}
        >
          Cancel
        </Button>
        <Button
          variant={severity === 'danger' ? 'danger' : 'primary'}
          onClick={handleConfirm}
          loading={loading}
        >
          {loading ? 'Executing...' : 'Confirm'}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

export default ActionConfirmationModal
