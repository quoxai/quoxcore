/**
 * FileChangeCard
 *
 * Renders AI-proposed file creation or editing as a collapsible preview card.
 * Users can expand to preview content (or diff for edits), then click "Apply".
 * Collapsed by default — no visual clutter in chat.
 *
 * State machine: idle → expanded → applying → applied | error
 * Edit diff states: idle → loading → loaded | failed
 *
 * Phase 4a: CREATE action with full content preview.
 * Phase 4b: EDIT action with diff view, backup, and undo.
 */

import { useState, useCallback, useEffect, useRef, useContext } from 'react';
import { writeFile, readFile, computeDiff, validateFilePath, getFilePolicy } from '../../services/terminalFileService';
import { FileChangeGroupContext } from './FileChangeGroup';
import FileApplyConfirmModal from './FileApplyConfirmModal';
import DiffView from './DiffView';
import './FileChangeCard.css';

/**
 * @param {object} props
 * @param {string} props.filePath - Absolute path for the file
 * @param {string} props.action - "create" or "edit"
 * @param {string} props.content - File content to write (full new content)
 * @param {object|null} props.meta - Optional metadata (reason, etc.)
 * @param {string|null} props.sessionId - Active terminal session ID
 * @param {string|undefined} props.targetPath - Target path (rename only)
 * @param {string} props.mode - Terminal mode (strict/balanced/builder/audit)
 * @param {function} [props.authFetch] - Authenticated fetch function
 */
export default function FileChangeCard({ filePath, action, content, meta, targetPath, sessionId, mode, authFetch }) {
  const [expanded, setExpanded] = useState(false);
  const [applyState, setApplyState] = useState('idle'); // idle | applying | applied | error
  const [statusMsg, setStatusMsg] = useState('');
  const [confirmPending, setConfirmPending] = useState(false); // strict mode confirm modal

  // Edit-specific state
  const [diffData, setDiffData] = useState(null);
  const [diffState, setDiffState] = useState('idle'); // idle | loading | loaded | failed
  const [diffError, setDiffError] = useState('');
  const [backupPath, setBackupPath] = useState(null);
  const [undoState, setUndoState] = useState('idle'); // idle | undoing | undone

  const diffFetchedRef = useRef(false);

  // Group context for multi-file coordination
  const group = useContext(FileChangeGroupContext);
  const cardId = useRef(`fcc-${filePath}-${action}`).current;

  const isEdit = action === 'edit';
  const isDelete = action === 'delete';
  const isRename = action === 'rename';
  const policy = getFilePolicy(mode);
  const pathValidation = validateFilePath(filePath);
  const targetValidation = isRename && targetPath ? validateFilePath(targetPath) : null;
  const isAudit = mode === 'audit';
  const noSession = !sessionId;
  const isBlocked = !pathValidation.valid || (targetValidation && !targetValidation.valid);

  // Delete always requires confirmation (even in balanced/builder) since destructive
  const forceConfirm = isDelete && !isAudit;

  const fileName = filePath.split('/').pop();

  // Badge color by action
  const badgeColor = isDelete ? '#ef4444' :
    isRename ? '#3b82f6' :
    isEdit ? '#f59e0b' : (
    pathValidation.severity === 'RED' ? '#ff4444' :
    pathValidation.severity === 'AMBER' ? '#ffb030' :
    pathValidation.severity === 'BLOCKED' ? '#ff4444' :
    '#22c55e'
  );

  // Fetch original file and compute diff when edit card is expanded
  useEffect(() => {
    if (!expanded || !isEdit || diffFetchedRef.current || diffState !== 'idle') return;
    if (noSession) return;

    diffFetchedRef.current = true;
    setDiffState('loading');

    readFile(sessionId, filePath, authFetch).then(result => {
      if (result.ok) {
        const diff = computeDiff(result.content, content);
        setDiffData(diff);
        setDiffState('loaded');
      } else {
        setDiffState('failed');
        setDiffError(result.error || 'Could not read original file');
      }
    }).catch(() => {
      setDiffState('failed');
      setDiffError('Network error reading file');
    });
  }, [expanded, isEdit, sessionId, filePath, content, authFetch, noSession, diffState]);

  // Register with group context for multi-file coordination
  useEffect(() => {
    if (!group) return;
    group.register(cardId, {
      filePath, action, applyState, targetPath,
      severity: pathValidation.severity,
      doApply: () => doApply(),
      setExpanded,
    });
    return () => group.unregister(cardId);
  }); // intentionally no deps — re-registers on every render to keep applyState current

  const handleToggle = useCallback(() => {
    setExpanded(prev => !prev);
  }, []);

  // Core apply logic (no confirmation gate)
  const doApply = useCallback(async () => {
    if (isAudit || noSession || isBlocked || applyState === 'applying') return;

    setApplyState('applying');
    setStatusMsg('');

    const extra = isRename && targetPath ? { targetPath } : undefined;
    const result = await writeFile(sessionId, filePath, content, action, authFetch, extra);

    if (result.ok) {
      setApplyState('applied');
      setStatusMsg(isDelete ? 'Deleted' : isRename ? 'Renamed' : 'Applied');
      if (result.backupPath) {
        setBackupPath(result.backupPath);
      }
      setTimeout(() => { setStatusMsg(''); }, 5000);
    } else {
      setApplyState('error');
      setStatusMsg(result.error || 'Failed');
      setTimeout(() => { setApplyState('idle'); setStatusMsg(''); }, 5000);
    }
  }, [sessionId, filePath, content, action, authFetch, isAudit, noSession, isBlocked, applyState, isRename, isDelete, targetPath]);

  // Apply handler — gates through confirmation modal in strict mode or for deletes
  const handleApply = useCallback(async () => {
    if (isAudit || noSession || isBlocked || applyState === 'applying') return;

    if (policy.requireConfirmModal || forceConfirm) {
      setConfirmPending(true);
    } else {
      doApply();
    }
  }, [isAudit, noSession, isBlocked, applyState, policy.requireConfirmModal, forceConfirm, doApply]);

  const handleConfirm = useCallback(() => {
    setConfirmPending(false);
    doApply();
  }, [doApply]);

  const handleConfirmClose = useCallback(() => {
    setConfirmPending(false);
  }, []);

  const handleUndo = useCallback(async () => {
    if (!backupPath || undoState === 'undoing') return;

    setUndoState('undoing');
    const result = await writeFile(sessionId, filePath, '', 'restore', authFetch, { backupPath });

    if (result.ok) {
      setUndoState('undone');
      setApplyState('idle');
      setBackupPath(null);
      setStatusMsg('Restored');
      // Reset diff state so it can be re-fetched
      setDiffData(null);
      setDiffState('idle');
      diffFetchedRef.current = false;
      setTimeout(() => { setStatusMsg(''); setUndoState('idle'); }, 3000);
    } else {
      setUndoState('idle');
      setStatusMsg(result.error || 'Undo failed');
      setTimeout(() => { setStatusMsg(''); }, 5000);
    }
  }, [sessionId, filePath, backupPath, authFetch, undoState]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).catch(() => {});
  }, [content]);

  const actionLabel = action.toUpperCase();

  return (
    <div className="file-change-card" data-severity={pathValidation.severity} data-action={action}>
      {/* Header — always visible */}
      <div className="file-change-card__header" onClick={handleToggle} role="button" tabIndex={0}>
        <div className="file-change-card__header-left">
          <svg className="file-change-card__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {isDelete ? (
              <>
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </>
            ) : isRename ? (
              <>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <path d="M9 15l3 3 3-3"/>
                <path d="M12 12v6"/>
              </>
            ) : isEdit ? (
              <>
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </>
            ) : (
              <>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </>
            )}
          </svg>
          {isRename ? (
            <span className="file-change-card__path file-change-card__path--rename" title={`${filePath} → ${targetPath}`}>
              <span>{filePath}</span>
              <span className="file-change-card__rename-arrow"> → </span>
              <span>{targetPath}</span>
            </span>
          ) : (
            <span className="file-change-card__path" title={filePath}>{filePath}</span>
          )}
        </div>
        <div className="file-change-card__header-right">
          <span className="file-change-card__badge" style={{ borderColor: badgeColor, color: badgeColor }}>
            {actionLabel}
          </span>
          <svg
            className={`file-change-card__chevron ${expanded ? 'file-change-card__chevron--open' : ''}`}
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="file-change-card__body">
          {/* Path severity warning */}
          {pathValidation.severity !== 'GREEN' && (
            <div className={`file-change-card__severity file-change-card__severity--${pathValidation.severity.toLowerCase()}`}>
              {pathValidation.reason}
            </div>
          )}

          {/* Content area: varies by action type */}

          {/* Delete: warning + optional reason */}
          {isDelete && (
            <div className="file-change-card__delete-warning">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span>This will permanently delete <strong>{fileName}</strong>. A backup will be created for undo.</span>
            </div>
          )}

          {/* Rename: path mapping display */}
          {isRename && (
            <div className="file-change-card__rename-detail">
              <div className="file-change-card__rename-row">
                <span className="file-change-card__rename-label">From:</span>
                <code className="file-change-card__rename-path">{filePath}</code>
              </div>
              <div className="file-change-card__rename-row">
                <span className="file-change-card__rename-label">To:</span>
                <code className="file-change-card__rename-path">{targetPath}</code>
              </div>
            </div>
          )}

          {/* Edit: diff view */}
          {isEdit && diffState === 'loading' && (
            <div className="file-change-card__diff-loading">
              <span className="file-change-card__spinner" />
              <span>Loading diff...</span>
            </div>
          )}

          {isEdit && diffState === 'loaded' && diffData && (
            <DiffView diff={diffData} />
          )}

          {isEdit && diffState === 'failed' && (
            <>
              <div className="file-change-card__diff-fallback">
                {diffError || 'Original not available'}
              </div>
              <pre className="file-change-card__preview">
                <code>{content}</code>
              </pre>
            </>
          )}

          {/* For create action or edit with no session (can't fetch diff) */}
          {(!isEdit && !isDelete && !isRename) && (
            <pre className="file-change-card__preview">
              <code>{content}</code>
            </pre>
          )}
          {isEdit && noSession && diffState === 'idle' && (
            <pre className="file-change-card__preview">
              <code>{content}</code>
            </pre>
          )}

          {/* Meta reason */}
          {meta?.reason && (
            <div className="file-change-card__meta">
              {meta.reason}
            </div>
          )}

          {/* Delete/rename reason from content body */}
          {(isDelete || isRename) && content && (
            <div className="file-change-card__meta">
              {content}
            </div>
          )}

          {/* Action buttons */}
          <div className="file-change-card__actions">
            {/* Status message */}
            {statusMsg && (
              <span className={`file-change-card__status file-change-card__status--${applyState === 'applied' ? 'applied' : applyState === 'error' ? 'error' : 'info'}`}>
                {(applyState === 'applied' || undoState === 'undone') && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
                {statusMsg}
              </span>
            )}

            {/* Audit mode badge */}
            {isAudit && (
              <span className="file-change-card__audit-badge">Audit mode</span>
            )}

            {/* Blocked badge */}
            {isBlocked && !isAudit && (
              <span className="file-change-card__blocked-badge">Blocked path</span>
            )}

            {/* Undo button — for edits, deletes, and renames after successful apply */}
            {(isEdit || isDelete || isRename) && applyState === 'applied' && backupPath && (
              <button
                className="file-change-card__btn file-change-card__btn--undo"
                onClick={handleUndo}
                disabled={undoState === 'undoing'}
                title="Restore original file from backup"
              >
                {undoState === 'undoing' ? (
                  <span className="file-change-card__spinner" />
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1 4 1 10 7 10"/>
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                  </svg>
                )}
                Undo
              </button>
            )}

            {/* Copy button — available for create/edit (not delete/rename) */}
            {!isDelete && !isRename && (
              <button className="file-change-card__btn file-change-card__btn--copy" onClick={handleCopy} title="Copy file content">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                Copy
              </button>
            )}

            {/* Apply button — gated by mode + session + path */}
            {policy.showApplyButtons && !isBlocked && (
              <button
                className={`file-change-card__btn file-change-card__btn--apply ${
                  isDelete ? 'file-change-card__btn--delete' : ''
                } ${
                  applyState === 'applied' ? 'file-change-card__btn--applied' : ''
                }`}
                onClick={handleApply}
                disabled={noSession || applyState === 'applying' || applyState === 'applied'}
                title={noSession ? 'No active terminal session' : `${isDelete ? 'Delete' : isRename ? 'Rename' : isEdit ? 'Edit' : 'Create'} ${fileName}`}
              >
                {applyState === 'applying' ? (
                  <span className="file-change-card__spinner" />
                ) : applyState === 'applied' ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                ) : isDelete ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                ) : isRename ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <path d="M9 15l3 3 3-3"/>
                    <path d="M12 12v6"/>
                  </svg>
                ) : isEdit ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                )}
                {applyState === 'applied' ? (isDelete ? 'Deleted' : isRename ? 'Renamed' : 'Applied') : (isDelete ? 'Delete' : isRename ? 'Rename' : 'Apply')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Strict mode confirmation modal */}
      {confirmPending && (
        <FileApplyConfirmModal
          isOpen={true}
          onClose={handleConfirmClose}
          onConfirm={handleConfirm}
          mode="single"
          filePath={filePath}
          action={action}
          content={content}
          severity={pathValidation.severity}
        />
      )}
    </div>
  );
}
