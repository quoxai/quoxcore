/**
 * UpdateHistory — Combined backup + update audit trail
 *
 * Shows past update operations and links to backup audit log.
 */

import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { createUpdateService } from '../../services/maintenance/updateService';
import { createBackupService } from '../../services/backup/backupService';

const STATUS_COLORS = {
    completed: '#10b981',
    failed: '#ef4444',
    cancelled: '#f59e0b',
    running: '#3b82f6',
    pending: '#6b7280',
    rolling_back: '#f59e0b',
    rolled_back: '#8b5cf6'
};

const STATUS_LABELS = {
    completed: 'Success',
    failed: 'Failed',
    cancelled: 'Cancelled',
    running: 'Running',
    pending: 'Pending',
    rolling_back: 'Rolling Back',
    rolled_back: 'Rolled Back'
};

function formatDate(dateStr) {
    if (!dateStr) return '—';
    try {
        return new Date(dateStr).toLocaleDateString('en-GB', {
            day: 'numeric', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch {
        return dateStr;
    }
}

function formatDuration(ms) {
    if (!ms) return '—';
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    return `${mins}m ${secs % 60}s`;
}

function UpdateHistory() {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();
    const [operations, setOperations] = useState([]);
    const [auditEntries, setAuditEntries] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [tab, setTab] = useState('updates');

    const updateSvc = useMemo(() => {
        if (!currentOrg?.id) return null;
        try { return createUpdateService(authFetch, currentOrg.id); } catch { return null; }
    }, [authFetch, currentOrg?.id]);

    const backupSvc = useMemo(() => {
        if (!currentOrg?.id) return null;
        try { return createBackupService(authFetch, currentOrg.id); } catch { return null; }
    }, [authFetch, currentOrg?.id]);

    useEffect(() => {
        async function load() {
            setLoading(true);
            try {
                const [updateData, auditData] = await Promise.allSettled([
                    updateSvc?.getUpdateHistory({ limit: 50 }),
                    backupSvc?.getAuditLog({ limit: 50 })
                ]);
                if (updateData.status === 'fulfilled') setOperations(updateData.value?.operations || []);
                if (auditData.status === 'fulfilled') setAuditEntries(auditData.value?.items || auditData.value?.entries || []);
                setError(null);
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        }
        if (updateSvc || backupSvc) load();
        else setLoading(false);
    }, [updateSvc, backupSvc]);

    if (loading) {
        return (
            <div className="update-history">
                <div className="update-history__loading">Loading audit log...</div>
            </div>
        );
    }

    return (
        <div className="update-history">
            <div className="update-history__tabs">
                <button
                    className={`update-history__tab ${tab === 'updates' ? 'update-history__tab--active' : ''}`}
                    onClick={() => setTab('updates')}
                >
                    Update Operations ({operations.length})
                </button>
                <button
                    className={`update-history__tab ${tab === 'backups' ? 'update-history__tab--active' : ''}`}
                    onClick={() => setTab('backups')}
                >
                    Backup Audit ({auditEntries.length})
                </button>
            </div>

            {error && (
                <div className="update-history__error">{error}</div>
            )}

            {tab === 'updates' && (
                <div className="update-history__table-wrap">
                    {operations.length === 0 ? (
                        <div className="update-history__empty">No update operations yet</div>
                    ) : (
                        <table className="update-history__table">
                            <thead>
                                <tr>
                                    <th>Version</th>
                                    <th>Status</th>
                                    <th>Date</th>
                                    <th>Duration</th>
                                    <th>Backup</th>
                                </tr>
                            </thead>
                            <tbody>
                                {operations.map(op => (
                                    <tr key={op.id} className={`update-history__row update-history__row--${op.status}`}>
                                        <td className="update-history__version">
                                            <span>v{op.from_version}</span>
                                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#6b7280" strokeWidth="2">
                                                <path d="M5 12h14M12 5l7 7-7 7" />
                                            </svg>
                                            <span>v{op.to_version}</span>
                                        </td>
                                        <td>
                                            <span className="update-history__status" style={{ color: STATUS_COLORS[op.status] || '#6b7280' }}>
                                                {STATUS_LABELS[op.status] || op.status}
                                            </span>
                                        </td>
                                        <td className="update-history__date">{formatDate(op.created_at)}</td>
                                        <td>{formatDuration(op.duration_ms)}</td>
                                        <td className="update-history__backup-id">
                                            {op.pre_update_backup_id
                                                ? <span title={op.pre_update_backup_id}>{op.pre_update_backup_id.slice(0, 12)}...</span>
                                                : '—'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {tab === 'backups' && (
                <div className="update-history__table-wrap">
                    {auditEntries.length === 0 ? (
                        <div className="update-history__empty">No backup audit entries yet</div>
                    ) : (
                        <table className="update-history__table">
                            <thead>
                                <tr>
                                    <th>Operation</th>
                                    <th>DEFCON</th>
                                    <th>Result</th>
                                    <th>Date</th>
                                    <th>Operator</th>
                                </tr>
                            </thead>
                            <tbody>
                                {auditEntries.map((entry, i) => (
                                    <tr key={entry.id || i}>
                                        <td>{entry.operation}</td>
                                        <td>
                                            <span className={`update-history__defcon update-history__defcon--${(entry.defcon_level || '').toLowerCase()}`}>
                                                {entry.defcon_level || '—'}
                                            </span>
                                        </td>
                                        <td>{entry.result || '—'}</td>
                                        <td className="update-history__date">{formatDate(entry.created_at)}</td>
                                        <td>{entry.operator || 'system'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}
        </div>
    );
}

export default UpdateHistory;
