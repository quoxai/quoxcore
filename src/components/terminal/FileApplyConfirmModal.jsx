/**
 * FileApplyConfirmModal
 *
 * Confirmation modal for file operations in strict mode.
 * Two modes:
 *   - single: Confirms a single file apply (path, action, severity, preview)
 *   - batch:  Confirms Apply All with a file list summary
 *
 * Uses the existing Modal + Button UI components.
 * Pattern follows TerminalExecConfirmModal.
 *
 * Phase 4c: Strict mode confirmation.
 */

import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { validateFilePath } from '../../services/terminalFileService';
import './FileApplyConfirmModal.css';

const SEVERITY_MODAL_MAP = {
  GREEN: 'default',
  AMBER: 'warning',
  RED: 'danger',
  BLOCKED: 'danger',
};

const ACTION_ICONS = {
  create: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="12" y1="18" x2="12" y2="12"/>
      <line x1="9" y1="15" x2="15" y2="15"/>
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  ),
};

const SEVERITY_COLORS = {
  GREEN: '#22c55e',
  AMBER: '#ffb030',
  RED: '#ff4444',
  BLOCKED: '#ff4444',
};

/**
 * Single file confirmation.
 */
function SingleFileContent({ filePath, action, content, severity }) {
  const previewLines = (content || '').split('\n').slice(0, 10);
  const truncated = (content || '').split('\n').length > 10;
  const validation = validateFilePath(filePath);

  return (
    <div className="file-apply-confirm__content">
      {/* File path */}
      <div className="file-apply-confirm__field">
        <div className="file-apply-confirm__label">File</div>
        <code className="file-apply-confirm__path">{filePath}</code>
      </div>

      {/* Action + severity */}
      <div className="file-apply-confirm__row">
        <div className="file-apply-confirm__field">
          <div className="file-apply-confirm__label">Action</div>
          <span
            className="file-apply-confirm__action-badge"
            style={{ color: action === 'edit' ? '#f59e0b' : '#22c55e' }}
          >
            {action.toUpperCase()}
          </span>
        </div>
        <div className="file-apply-confirm__field">
          <div className="file-apply-confirm__label">Path Risk</div>
          <span
            className="file-apply-confirm__severity-badge"
            style={{ color: SEVERITY_COLORS[severity || validation.severity] }}
          >
            {severity || validation.severity}
          </span>
        </div>
      </div>

      {/* Warning for non-green paths */}
      {validation.severity !== 'GREEN' && validation.reason && (
        <div className="file-apply-confirm__warning">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          {validation.reason}
        </div>
      )}

      {/* Content preview */}
      <div className="file-apply-confirm__field">
        <div className="file-apply-confirm__label">Preview</div>
        <pre className="file-apply-confirm__preview">
          <code>{previewLines.join('\n')}</code>
          {truncated && <span className="file-apply-confirm__truncated">... truncated</span>}
        </pre>
      </div>
    </div>
  );
}

/**
 * Batch file list confirmation.
 */
function BatchFileContent({ files }) {
  return (
    <div className="file-apply-confirm__content">
      <div className="file-apply-confirm__batch-list">
        {files.map((f, i) => {
          const validation = validateFilePath(f.filePath);
          const sevColor = SEVERITY_COLORS[f.severity || validation.severity];
          return (
            <div key={i} className="file-apply-confirm__batch-item">
              <span className="file-apply-confirm__batch-icon" style={{ color: f.action === 'edit' ? '#f59e0b' : '#22c55e' }}>
                {f.action === 'edit' ? '\u270E' : '\u271A'}
              </span>
              <code className="file-apply-confirm__batch-path">{f.filePath}</code>
              <span className="file-apply-confirm__batch-action" style={{ color: f.action === 'edit' ? '#f59e0b' : '#22c55e' }}>
                {f.action.toUpperCase()}
              </span>
              {(f.severity || validation.severity) !== 'GREEN' && (
                <span className="file-apply-confirm__batch-severity" style={{ color: sevColor }}>
                  {f.severity || validation.severity}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {function} props.onClose
 * @param {function} props.onConfirm
 * @param {'single'|'batch'} props.mode - single file or batch
 * @param {string} [props.filePath] - for single mode
 * @param {string} [props.action] - for single mode
 * @param {string} [props.content] - for single mode
 * @param {string} [props.severity] - for single mode
 * @param {Array} [props.files] - for batch mode: [{ filePath, action, severity }]
 */
export default function FileApplyConfirmModal({ isOpen, onClose, onConfirm, mode, filePath, action, content, severity, files }) {
  const isBatch = mode === 'batch';
  const fileCount = isBatch ? (files || []).length : 1;

  // Determine modal severity from worst file
  let modalSeverity = 'default';
  if (isBatch) {
    for (const f of (files || [])) {
      const v = validateFilePath(f.filePath);
      const sev = f.severity || v.severity;
      if (sev === 'RED' || sev === 'BLOCKED') { modalSeverity = 'danger'; break; }
      if (sev === 'AMBER') modalSeverity = 'warning';
    }
  } else {
    const v = validateFilePath(filePath);
    modalSeverity = SEVERITY_MODAL_MAP[severity || v.severity] || 'default';
  }

  const title = isBatch ? `Apply ${fileCount} Files` : `${action === 'edit' ? 'Edit' : 'Create'} File`;
  const icon = isBatch ? ACTION_ICONS.create : (ACTION_ICONS[action] || ACTION_ICONS.create);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      severity={modalSeverity}
      size="md"
    >
      <Modal.Header
        title={title}
        description="Strict mode requires confirmation before file changes"
        icon={icon}
        badge="CONFIRM"
        onClose={onClose}
      />

      <Modal.Body>
        {isBatch ? (
          <BatchFileContent files={files || []} />
        ) : (
          <SingleFileContent filePath={filePath} action={action} content={content} severity={severity} />
        )}
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
          variant={modalSeverity === 'danger' ? 'danger' : 'primary'}
          onClick={onConfirm}
          icon={
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          }
        >
          {isBatch ? `Apply ${fileCount} Files` : 'Confirm'}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
