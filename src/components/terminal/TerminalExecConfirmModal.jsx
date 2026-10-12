/**
 * TerminalExecConfirmModal
 *
 * Confirmation modal for commands that require approval before terminal execution.
 * Pattern based on CommandValidationModal.jsx from BastionPanel.
 */

import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { getSeverityColor } from '../../config/denylist';

const ACTION_CONFIG = {
  WARN: {
    title: 'Warning',
    modalSeverity: 'warning',
    badge: 'WARNING',
    confirmLabel: 'Run Anyway',
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
    confirmLabel: 'Approve & Run',
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
    confirmLabel: 'Override & Run',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
      </svg>
    )
  }
};

export default function TerminalExecConfirmModal({ isOpen, onClose, command, validation, onConfirm }) {
  if (!validation) return null;

  const action = validation.action || 'WARN';
  const config = ACTION_CONFIG[action];
  if (!config) return null;

  const severityColor = getSeverityColor(validation.severity);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      severity={config.modalSeverity}
      size="md"
    >
      <Modal.Header
        title={config.title}
        description="Command requires confirmation before execution"
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

          {/* Context */}
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
              <polyline points="4 17 10 11 4 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="12" y1="19" x2="20" y2="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <div>
              <div style={{
                fontSize: '0.7rem',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                color: 'var(--ui-text-muted, #666)',
                marginBottom: '0.125rem'
              }}>
                Target
              </div>
              <div style={{
                fontSize: '0.875rem',
                color: 'var(--ui-text-primary, white)',
                fontWeight: 500
              }}>
                Active terminal session
              </div>
            </div>
          </div>

          {/* Reason */}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
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
        </div>
      </Modal.Body>

      <Modal.Footer>
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
          variant={config.modalSeverity === 'danger' ? 'danger' : 'primary'}
          onClick={onConfirm}
          icon={
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5"/>
              <line x1="12" y1="19" x2="20" y2="19"/>
            </svg>
          }
        >
          {config.confirmLabel}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
