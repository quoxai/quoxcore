/**
 * Backup Progress Component
 * Shows real-time progress of backup operations.
 */

import { formatBytes, formatDuration } from '../../services/backup/backupService'

export function BackupProgress({ backup }) {
    if (!backup) return null

    const isRunning = backup.status === 'running' || backup.status === 'verifying'
    const progress = backup.progress || 0

    return (
        <div className={`backup-progress ${backup.status}`}>
            <div className="backup-progress-header">
                <span className="backup-progress-title">
                    {backup.status === 'verifying' ? 'Verifying Backup...' : 'Creating Backup...'}
                </span>
                <span className="backup-progress-name">{backup.name}</span>
            </div>

            <div className="backup-progress-bar-container">
                <div
                    className="backup-progress-bar"
                    style={{ width: isRunning ? '100%' : `${progress}%` }}
                >
                    {isRunning && <div className="backup-progress-bar-animated"></div>}
                </div>
            </div>

            <div className="backup-progress-details">
                {backup.currentComponent && (
                    <span className="backup-progress-component">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                        </svg>
                        {backup.currentComponent}
                    </span>
                )}
                {backup.filesProcessed !== undefined && (
                    <span className="backup-progress-files">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
                        </svg>
                        {backup.filesProcessed} files
                    </span>
                )}
                {backup.bytesProcessed !== undefined && (
                    <span className="backup-progress-bytes">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                        </svg>
                        {formatBytes(backup.bytesProcessed)}
                    </span>
                )}
                {backup.started_at && (
                    <span className="backup-progress-elapsed">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        {formatDuration(Date.now() - new Date(backup.started_at).getTime())}
                    </span>
                )}
            </div>
        </div>
    )
}

export default BackupProgress
