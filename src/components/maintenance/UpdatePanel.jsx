/**
 * UpdatePanel — Main update tab content
 *
 * Shows current version, available updates, changelog, update button,
 * progress tracking, and recent update history.
 */

import { useState, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import useUpdateStatus from '../../hooks/useUpdateStatus';
import useUpdateProgress from '../../hooks/useUpdateProgress';
import { createUpdateService, getLocalVersion } from '../../services/maintenance/updateService';
import UpdateProgress from './UpdateProgress';

function timeAgo(dateStr) {
    if (!dateStr) return 'Never';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function UpdatePanel() {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();
    const { status, loading, error, checking, checkNow } = useUpdateStatus();
    const [updating, setUpdating] = useState(false);
    const [updateError, setUpdateError] = useState(null);

    const isUpdateRunning = status?.active_operation?.status === 'running' || updating;
    const progress = useUpdateProgress(isUpdateRunning);

    const handleStartUpdate = useCallback(async () => {
        if (!currentOrg?.id) return;
        setUpdating(true);
        setUpdateError(null);
        try {
            const svc = createUpdateService(authFetch, currentOrg.id);
            await svc.startUpdate();
        } catch (err) {
            setUpdateError(err.message);
            setUpdating(false);
        }
    }, [authFetch, currentOrg?.id]);

    const handleCancelUpdate = useCallback(async () => {
        if (!currentOrg?.id) return;
        try {
            const svc = createUpdateService(authFetch, currentOrg.id);
            await svc.cancelUpdate();
            setUpdating(false);
        } catch (err) {
            setUpdateError(err.message);
        }
    }, [authFetch, currentOrg?.id]);

    const handleRollback = useCallback(async () => {
        if (!currentOrg?.id) return;
        if (!window.confirm('This will restore the pre-update backup and revert to the previous version. Continue?')) return;
        setUpdateError(null);
        try {
            const svc = createUpdateService(authFetch, currentOrg.id);
            await svc.rollbackUpdate();
            setUpdating(true);
        } catch (err) {
            setUpdateError(err.message);
        }
    }, [authFetch, currentOrg?.id]);

    if (loading) {
        return (
            <div className="update-panel">
                <div className="update-panel__loading">
                    <div className="update-panel__spinner" />
                    <span>Checking system status...</span>
                </div>
            </div>
        );
    }

    const currentVersion = status?.current_version || getLocalVersion();
    const availableVersion = status?.available_version;
    const updateAvailable = status?.update_available;
    const lastCheck = status?.last_check;
    const autoBackup = status?.settings?.auto_backup_before_update !== 0;

    return (
        <div className="update-panel">
            {/* Version header */}
            <div className="update-panel__version-bar">
                <div className="update-panel__version-current">
                    <span className="update-panel__version-label">Current</span>
                    <span className="update-panel__version-number">v{currentVersion}</span>
                </div>
                {updateAvailable && (
                    <>
                        <div className="update-panel__version-arrow">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M5 12h14M12 5l7 7-7 7" />
                            </svg>
                        </div>
                        <div className="update-panel__version-available">
                            <span className="update-panel__version-label">Available</span>
                            <span className="update-panel__version-number update-panel__version-number--new">v{availableVersion}</span>
                        </div>
                    </>
                )}
                <button
                    className="update-panel__check-btn"
                    onClick={checkNow}
                    disabled={checking || isUpdateRunning}
                    title="Check for updates"
                >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" className={checking ? 'update-panel__spin' : ''}>
                        <path d="M23 4v6h-6M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                    </svg>
                    <span>{checking ? 'Checking...' : 'Check Now'}</span>
                </button>
            </div>

            {lastCheck && (
                <div className="update-panel__last-check">
                    Last checked: {timeAgo(lastCheck)}
                </div>
            )}

            {error && (
                <div className="update-panel__error">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    <span>{error}</span>
                </div>
            )}
            {updateError && (
                <div className="update-panel__error">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    <span>{updateError}</span>
                </div>
            )}

            {/* Update progress (shown when running) */}
            {isUpdateRunning && (
                <UpdateProgress
                    progress={progress}
                    onCancel={handleCancelUpdate}
                />
            )}

            {/* Changelog */}
            {updateAvailable && status?.release_notes_md && !isUpdateRunning && (
                <div className="update-panel__changelog">
                    <h3 className="update-panel__changelog-title">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                            <polyline points="14,2 14,8 20,8" />
                        </svg>
                        What's new in v{availableVersion}
                    </h3>
                    <div className="update-panel__changelog-body">
                        <pre>{status.release_notes_md}</pre>
                    </div>
                    {status?.release_url && (
                        <a href={status.release_url} target="_blank" rel="noopener noreferrer" className="update-panel__release-link">
                            View on GitHub
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                            </svg>
                        </a>
                    )}
                </div>
            )}

            {/* Pre-update safety & update button */}
            {updateAvailable && !isUpdateRunning && (
                <div className="update-panel__actions">
                    <div className="update-panel__safety">
                        <h4>Pre-update safety</h4>
                        <label className="update-panel__safety-item">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={autoBackup ? '#10b981' : '#6b7280'} strokeWidth="2">
                                {autoBackup
                                    ? <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12l2 2 4-4" /></>
                                    : <rect x="3" y="3" width="18" height="18" rx="2" />
                                }
                            </svg>
                            <span>Auto-backup before update</span>
                        </label>
                        <label className="update-panel__safety-item">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#10b981" strokeWidth="2">
                                <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12l2 2 4-4" />
                            </svg>
                            <span>Health check all services first</span>
                        </label>
                    </div>

                    <button
                        className="update-panel__update-btn"
                        onClick={handleStartUpdate}
                        disabled={isUpdateRunning}
                    >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                        </svg>
                        Update to v{availableVersion}
                    </button>
                </div>
            )}

            {/* No update state */}
            {!updateAvailable && !isUpdateRunning && !loading && (
                <div className="update-panel__up-to-date">
                    <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="#10b981" strokeWidth="2">
                        <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                        <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                    <span>QuoxCORE is up to date</span>
                </div>
            )}

            {/* Rollback option (shown if last update was recent) */}
            {!isUpdateRunning && status?.active_operation === null && (
                <div className="update-panel__rollback-section">
                    <button
                        className="update-panel__rollback-btn"
                        onClick={handleRollback}
                        title="Rollback to previous version using pre-update backup"
                    >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="1 4 1 10 7 10" />
                            <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
                        </svg>
                        Rollback last update
                    </button>
                </div>
            )}
        </div>
    );
}

export default UpdatePanel;
