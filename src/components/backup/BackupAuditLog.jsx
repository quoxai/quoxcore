/**
 * Backup Audit Log Component
 * Displays DEFCON-style audit entries for backup operations.
 */

import { DEFCON_COLORS } from '../../services/backup/backupIntents'
import { formatDuration } from '../../services/backup/backupService'

/**
 * DEFCON badge component
 */
function DefconBadge({ level }) {
    const config = DEFCON_COLORS[level] || DEFCON_COLORS.GREEN

    return (
        <span
            className="defcon-badge"
            style={{
                backgroundColor: config.bg,
                color: config.text
            }}
        >
            {level}
        </span>
    )
}

/**
 * Result badge component
 */
function ResultBadge({ result }) {
    const resultConfig = {
        success: { bg: '#dcfce7', text: '#166534' },
        failed: { bg: '#fecaca', text: '#b91c1c' },
        pending: { bg: '#fef3c7', text: '#92400e' },
        blocked: { bg: '#fecaca', text: '#b91c1c' },
        dry_run: { bg: '#dbeafe', text: '#1e40af' }
    }

    const config = resultConfig[result] || resultConfig.pending

    return (
        <span
            className="result-badge"
            style={{
                backgroundColor: config.bg,
                color: config.text
            }}
        >
            {result.replace('_', ' ')}
        </span>
    )
}

/**
 * Audit entry card
 */
function AuditEntry({ entry }) {
    const timestamp = new Date(entry.created_at).toLocaleString()
    const metadata = entry.metadata || {}

    return (
        <div className={`audit-entry defcon-${entry.defcon_level?.toLowerCase()}`}>
            <div className="audit-entry-header">
                <div className="audit-entry-badges">
                    <DefconBadge level={entry.defcon_level} />
                    <ResultBadge result={entry.result} />
                </div>
                <span className="audit-entry-time">{timestamp}</span>
            </div>

            <div className="audit-entry-operation">
                <strong>{entry.operation}</strong>
                {entry.backup_id && (
                    <span className="audit-entry-target">
                        Backup: {entry.backup_id.slice(0, 8)}...
                    </span>
                )}
                {entry.restore_id && (
                    <span className="audit-entry-target">
                        Restore: {entry.restore_id.slice(0, 8)}...
                    </span>
                )}
            </div>

            <div className="audit-entry-details">
                <span className="audit-entry-operator">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
                    </svg>
                    {entry.operator || 'system'}
                </span>
                {entry.duration_ms && (
                    <span className="audit-entry-duration">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        {formatDuration(entry.duration_ms)}
                    </span>
                )}
            </div>

            {Object.keys(metadata).length > 0 && (
                <details className="audit-entry-metadata">
                    <summary>Metadata</summary>
                    <pre>{JSON.stringify(metadata, null, 2)}</pre>
                </details>
            )}
        </div>
    )
}

/**
 * Backup Audit Log component
 */
export function BackupAuditLog({ entries, onRefresh }) {
    return (
        <div className="backup-audit-log">
            <div className="audit-log-header">
                <div className="audit-log-legend">
                    <span className="legend-title">DEFCON Levels:</span>
                    {Object.entries(DEFCON_COLORS).map(([level, config]) => (
                        <span
                            key={level}
                            className="legend-item"
                            style={{ backgroundColor: config.bg, color: config.text }}
                        >
                            {level}: {config.label}
                        </span>
                    ))}
                </div>
                <button className="refresh-btn" onClick={onRefresh}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 12a9 9 0 11-6.22-8.56"/><path d="M21 3v6h-6"/>
                    </svg>
                    Refresh
                </button>
            </div>

            {entries.length === 0 ? (
                <div className="audit-log-empty">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.5">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
                    </svg>
                    <h3>No Audit Entries</h3>
                    <p>Backup operations will appear here once you create your first backup.</p>
                </div>
            ) : (
                <div className="audit-entries">
                    {entries.map(entry => (
                        <AuditEntry key={entry.id} entry={entry} />
                    ))}
                </div>
            )}
        </div>
    )
}

export default BackupAuditLog
