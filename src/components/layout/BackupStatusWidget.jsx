/**
 * BackupStatusWidget — Compact sidebar widget showing backup health + update status.
 * Clickable — navigates to /system (System Maintenance).
 * Shows error state instead of hiding when status can't be fetched.
 */

import { useNavigate } from 'react-router-dom'
import { useBackupStatus } from '../../hooks/useBackupStatus'
import { useUpdateStatus } from '../../hooks/useUpdateStatus'

const HEALTH_COLORS = {
    healthy: '#10b981',
    warning: '#f59e0b',
    critical: '#ef4444',
    unknown: '#6b7280'
}

function timeAgo(dateStr) {
    if (!dateStr) return 'Never'
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'Just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
}

export function BackupStatusWidget({ collapsed }) {
    const navigate = useNavigate()
    const { status, loading, error } = useBackupStatus()
    const { status: updateStatusData } = useUpdateStatus()

    const updateAvailable = updateStatusData?.update_available

    // Still loading on first fetch
    if (loading && !status && !error) return null

    // Error state — show critical dot so user knows something is wrong
    if (error && !status) {
        const color = HEALTH_COLORS.unknown
        return (
            <button
                className="backup-status-widget"
                onClick={() => navigate('/system')}
                title={`System: status unavailable`}
            >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--shell-text-muted, #71717a)', flexShrink: 0 }}>
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <span className="backup-widget-dot" style={{ background: color }} />
                {!collapsed && (
                    <span className="backup-widget-label">System: unknown</span>
                )}
            </button>
        )
    }

    if (!status) return null

    const health = status.health || 'unknown'
    // If update available, show blue dot; otherwise show backup health color
    const dotColor = updateAvailable ? '#3b82f6' : HEALTH_COLORS[health]
    const lastBackup = status.lastSuccess?.completedAt
    const isCritical = health === 'critical'

    const label = updateAvailable
        ? 'Update available'
        : (lastBackup ? `Backup: ${timeAgo(lastBackup)}` : 'No backups')

    return (
        <button
            className="backup-status-widget"
            onClick={() => navigate('/system')}
            title={`System: ${health} — ${label}`}
        >
            {/* Shield icon */}
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--shell-text-muted, #71717a)', flexShrink: 0 }}>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>

            {/* Status dot */}
            <span
                className={`backup-widget-dot ${isCritical ? 'backup-widget-dot--pulse' : ''}`}
                style={{ background: dotColor }}
            />

            {/* Label — hidden when collapsed */}
            {!collapsed && (
                <span className="backup-widget-label">{label}</span>
            )}
        </button>
    )
}

export default BackupStatusWidget
