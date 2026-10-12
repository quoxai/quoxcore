/**
 * Backup History Component
 * Displays list of backups with actions for verify, restore, delete.
 */

import { formatBytes, formatDuration } from '../../services/backup/backupService'
import { DEFCON_COLORS } from '../../services/backup/backupIntents'

/**
 * Status badge component
 */
function StatusBadge({ status }) {
    const statusConfig = {
        pending: { color: '#9ca3af', label: 'Pending' },
        running: { color: '#3b82f6', label: 'Running' },
        completed: { color: '#10b981', label: 'Completed' },
        verified: { color: '#059669', label: 'Verified' },
        verifying: { color: '#6366f1', label: 'Verifying' },
        degraded: { color: '#f59e0b', label: 'Degraded (incomplete)' },
        failed: { color: '#ef4444', label: 'Failed' },
        cancelled: { color: '#f59e0b', label: 'Cancelled' }
    }

    const config = statusConfig[status] || statusConfig.pending

    return (
        <span
            className="backup-status-badge"
            style={{ backgroundColor: config.color }}
        >
            {config.label}
        </span>
    )
}

/**
 * Backup card component
 */
function BackupCard({ backup, onDelete, onVerify, onRestore }) {
    const createdAt = new Date(backup.created_at).toLocaleString()
    const isRestorable = ['completed', 'verified', 'degraded'].includes(backup.status)
    const isVerifiable = backup.status === 'completed' || backup.status === 'degraded'

    return (
        <div className={`backup-card ${backup.status}`}>
            <div className="backup-card-header">
                <div className="backup-card-title">
                    <span className="backup-name">{backup.name || `Backup ${backup.id.slice(0, 8)}`}</span>
                    <StatusBadge status={backup.status} />
                </div>
                <span className="backup-type-badge">{backup.backup_type}</span>
            </div>

            <div className="backup-card-meta">
                <span className="backup-meta-item">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    {createdAt}
                </span>
                {backup.archive_size_bytes && (
                    <span className="backup-meta-item">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                        </svg>
                        {formatBytes(backup.archive_size_bytes)}
                    </span>
                )}
                {backup.duration_ms && (
                    <span className="backup-meta-item">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        {formatDuration(backup.duration_ms)}
                    </span>
                )}
            </div>

            {backup.components && backup.components.length > 0 && (
                <div className="backup-components-list">
                    {backup.components.slice(0, 4).map(comp => (
                        <span key={comp} className="backup-component-tag">{comp}</span>
                    ))}
                    {backup.components.length > 4 && (
                        <span className="backup-component-tag more">+{backup.components.length - 4} more</span>
                    )}
                </div>
            )}

            {backup.verification && (
                <div className={`backup-verification ${backup.verification.valid ? 'valid' : 'invalid'}`}>
                    {backup.verification.valid && backup.verification.complete === false ? (
                        <>Archive hash valid, but INCOMPLETE: required components skipped ({(backup.verification.skippedRequired || []).join(', ') || 'unknown'})</>
                    ) : backup.verification.valid ? (
                        <>
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>
                            </svg>
                            Verified
                        </>
                    ) : (
                        <>
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                            </svg>
                            Verification Failed
                        </>
                    )}
                </div>
            )}

            {backup.error_message && (
                <div className="backup-error-message">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                    </svg>
                    {backup.error_message}
                </div>
            )}

            <div className="backup-card-actions">
                {isVerifiable && (
                    <button
                        className="backup-action-btn verify"
                        onClick={() => onVerify(backup.id)}
                        title="Verify Integrity"
                    >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>
                        </svg>
                        Verify
                    </button>
                )}
                {isRestorable && (
                    <button
                        className="backup-action-btn restore"
                        onClick={() => onRestore(backup)}
                        title="Restore from Backup"
                    >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 12a9 9 0 11-6.22-8.56"/><path d="M21 3v6h-6"/>
                        </svg>
                        Restore
                    </button>
                )}
                <button
                    className="backup-action-btn delete"
                    onClick={() => onDelete(backup.id)}
                    title="Delete Backup"
                >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                    </svg>
                    Delete
                </button>
            </div>
        </div>
    )
}

/**
 * Backup History list component
 */
export function BackupHistory({ backups, onDelete, onVerify, onRestore, onScan, scanning, loading }) {
    if (loading) {
        return (
            <div className="backup-history-loading">
                <div className="backup-spinner"></div>
                <span>Loading backups...</span>
            </div>
        )
    }

    if (backups.length === 0) {
        return (
            <div className="backup-history-empty">
                <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.5">
                    <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/><path d="M12 13v7"/><polyline points="9 17 12 20 15 17"/>
                </svg>
                <h3>No Backups Yet</h3>
                <p>Create your first backup to protect your data, or scan the backup directory for existing archives.</p>
                {onScan && (
                    <button
                        className="backup-scan-btn"
                        onClick={onScan}
                        disabled={scanning}
                    >
                        {scanning ? (
                            <><span className="backup-spinner" style={{ width: 14, height: 14 }} /> Scanning...</>
                        ) : (
                            <><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scan for Backup Archives</>
                        )}
                    </button>
                )}
            </div>
        )
    }

    return (
        <div className="backup-history">
            {backups.map(backup => (
                <BackupCard
                    key={backup.id}
                    backup={backup}
                    onDelete={onDelete}
                    onVerify={onVerify}
                    onRestore={onRestore}
                />
            ))}
        </div>
    )
}

export default BackupHistory
