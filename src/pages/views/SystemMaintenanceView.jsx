/**
 * SystemMaintenanceView — Unified System Maintenance Dashboard
 *
 * Single view for ALL maintenance operations:
 *   - Overview: health summary, version, quick actions
 *   - Backups: full BackupPanel (create, restore, schedule, verify, audit)
 *   - Updates: version check, changelog, update execution, rollback
 *   - Audit Log: combined backup + update history
 *
 * KEEPER chat sidebar always present (collapsible).
 * This is the ONLY maintenance view — /backup redirects here.
 */

import { useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { BackupPanel } from '../../components/backup';
import UpdatePanel from '../../components/maintenance/UpdatePanel';
import UpdateHistory from '../../components/maintenance/UpdateHistory';
import { KeeperChatSidebar } from '../../components/maintenance/KeeperChatSidebar';
import { useUpdateStatus } from '../../hooks/useUpdateStatus';
import { useBackupStatus } from '../../hooks/useBackupStatus';

const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'backups', label: 'Backups' },
    { id: 'updates', label: 'Updates' },
    { id: 'audit', label: 'Audit Log' },
];

// ─── Overview Panel ─────────────────────────────────────────
function OverviewPanel({ backupStatus, updateStatus }) {
    const lastBackup = backupStatus?.last_backup_at
        ? new Date(backupStatus.last_backup_at).toLocaleString()
        : 'Never';
    const totalBackups = backupStatus?.total_backups || 0;
    const failedBackups = backupStatus?.failed_backups || 0;
    const activeSchedules = backupStatus?.active_schedules || 0;
    const currentVersion = updateStatus?.current_version || import.meta.env.VITE_QUOXCORE_VERSION || '0.0.0';
    const updateAvailable = updateStatus?.update_available;
    const availableVersion = updateStatus?.available_version;

    return (
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Version + Update Status */}
            <div style={cardStyle}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                        <div style={labelStyle}>QuoxCORE Version</div>
                        <div style={{ fontSize: 28, fontWeight: 700, color: 'rgba(255,255,255,0.95)', fontVariantNumeric: 'tabular-nums' }}>
                            v{currentVersion}
                        </div>
                    </div>
                    <div style={{
                        padding: '6px 14px',
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 700,
                        background: updateAvailable ? 'rgba(20, 184, 166, 0.15)' : 'rgba(52, 211, 153, 0.1)',
                        color: updateAvailable ? 'rgba(20, 184, 166, 0.95)' : 'rgba(52, 211, 153, 0.9)',
                        border: `1px solid ${updateAvailable ? 'rgba(20, 184, 166, 0.2)' : 'rgba(52, 211, 153, 0.15)'}`,
                    }}>
                        {updateAvailable ? `v${availableVersion} available` : 'Up to date'}
                    </div>
                </div>
            </div>

            {/* Backup Health */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
                <div style={statCardStyle}>
                    <div style={statNumberStyle}>{totalBackups}</div>
                    <div style={statLabelStyle}>Backups</div>
                </div>
                <div style={statCardStyle}>
                    <div style={{ ...statNumberStyle, color: failedBackups > 0 ? 'rgba(248, 113, 113, 0.9)' : 'rgba(52, 211, 153, 0.9)' }}>
                        {failedBackups}
                    </div>
                    <div style={statLabelStyle}>Failed</div>
                </div>
                <div style={statCardStyle}>
                    <div style={statNumberStyle}>{activeSchedules}</div>
                    <div style={statLabelStyle}>Schedules</div>
                </div>
                <div style={statCardStyle}>
                    <div style={{ ...statNumberStyle, fontSize: 14, color: 'rgba(255,255,255,0.7)' }}>{lastBackup}</div>
                    <div style={statLabelStyle}>Last Backup</div>
                </div>
            </div>

            {/* Quick Actions */}
            <div style={cardStyle}>
                <div style={{ ...labelStyle, marginBottom: 12 }}>Quick Actions</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <QuickAction label="Create Backup" hint="Full system backup" tab="backups" />
                    <QuickAction label="Check for Updates" hint="Query GitHub Releases" tab="updates" />
                    <QuickAction label="View Audit Log" hint="Maintenance history" tab="audit" />
                    <QuickAction label="Ask KEEPER" hint="AI guidance" action="keeper" />
                </div>
            </div>

            {/* What This Plugin Does */}
            <div style={{ ...cardStyle, borderColor: 'rgba(20, 184, 166, 0.1)' }}>
                <div style={{ ...labelStyle, color: 'rgba(20, 184, 166, 0.8)', marginBottom: 8 }}>System Maintenance</div>
                <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, lineHeight: 1.6 }}>
                    Backup, restore, migrate, and update QuoxCORE from this dashboard. The <strong style={{ color: 'rgba(20, 184, 166, 0.9)' }}>Backups</strong> tab
                    handles creating, restoring, scheduling, and verifying backups across 21 components. The <strong style={{ color: 'rgba(20, 184, 166, 0.9)' }}>Updates</strong> tab
                    checks for new versions, shows changelogs, and runs the update pipeline with automatic pre-update backup.
                    <strong style={{ color: 'rgba(20, 184, 166, 0.9)' }}> KEEPER</strong> (sidebar) is your AI continuity specialist — ask it anything about backups, restores, or updates.
                </div>
            </div>
        </div>
    );
}

function QuickAction({ label, hint }) {
    return (
        <div style={{
            padding: '10px 16px',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            cursor: 'pointer',
            transition: 'all 0.15s',
            flex: '1 1 180px',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(20, 184, 166, 0.08)'; e.currentTarget.style.borderColor = 'rgba(20, 184, 166, 0.2)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
        >
            <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>{label}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>{hint}</div>
        </div>
    );
}

// ─── Styles ─────────────────────────────────────────────────
const cardStyle = {
    padding: '16px 20px',
    background: 'rgba(255, 255, 255, 0.05)',
    border: '1px solid rgba(255, 255, 255, 0.14)',
    borderRadius: 12,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), inset 0 -1px 0 rgba(0,0,0,0.25)',
};

const labelStyle = {
    fontSize: 11,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.65)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
};

const statCardStyle = {
    ...cardStyle,
    textAlign: 'center',
    padding: '16px 12px',
};

const statNumberStyle = {
    fontSize: 24,
    fontWeight: 700,
    color: 'rgba(20, 184, 166, 0.9)',
    fontVariantNumeric: 'tabular-nums',
};

const statLabelStyle = {
    fontSize: 11,
    color: 'rgba(255,255,255,0.45)',
    marginTop: 4,
};

// ─── Main View ──────────────────────────────────────────────
function SystemMaintenanceView() {
    const { halState } = useOutletContext() || {};
    const [searchParams, setSearchParams] = useSearchParams();
    const activeTab = searchParams.get('tab') || 'overview';
    const [showKeeper, setShowKeeper] = useState(true);

    const { status: updateStatus } = useUpdateStatus();
    const { status: backupStatus } = useBackupStatus();

    const setTab = (tabId) => {
        setSearchParams({ tab: tabId });
    };

    return (
        <div className="smv" style={smvStyles.root}>
            {/* Header */}
            <div style={smvStyles.header}>
                <div style={smvStyles.titleRow}>
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" style={{ stroke: 'rgba(20, 184, 166, 0.9)' }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                    <h1 style={smvStyles.title}>System Maintenance</h1>
                    <span style={smvStyles.version}>v{import.meta.env.VITE_QUOXCORE_VERSION || '0.0.0'}</span>
                </div>

                {/* Tab bar */}
                <div style={smvStyles.tabBar}>
                    {TABS.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setTab(tab.id)}
                            style={{
                                ...smvStyles.tab,
                                ...(activeTab === tab.id ? smvStyles.tabActive : {}),
                            }}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Body: content + keeper sidebar */}
            <div style={smvStyles.body}>
                <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
                    {activeTab === 'overview' && <OverviewPanel backupStatus={backupStatus} updateStatus={updateStatus} />}
                    {activeTab === 'backups' && <BackupPanel />}
                    {activeTab === 'updates' && <UpdatePanel />}
                    {activeTab === 'audit' && <UpdateHistory />}
                </div>

                {/* KEEPER sidebar */}
                <div style={{
                    width: showKeeper ? 340 : 0,
                    minWidth: showKeeper ? 340 : 0,
                    maxWidth: showKeeper ? 340 : 0,
                    overflow: 'hidden',
                    transition: 'width 0.25s ease, min-width 0.25s ease, opacity 0.2s ease',
                    opacity: showKeeper ? 1 : 0,
                    borderLeft: showKeeper ? '1px solid rgba(20, 184, 166, 0.1)' : 'none',
                    pointerEvents: showKeeper ? 'auto' : 'none',
                    height: '100%',
                }}>
                    <KeeperChatSidebar
                        backups={backupStatus?.recent_backups || []}
                        schedules={backupStatus?.schedules || []}
                        components={backupStatus?.components || []}
                        updateStatus={updateStatus}
                    />
                </div>

                {/* Toggle */}
                <button
                    onClick={() => setShowKeeper(v => !v)}
                    title={showKeeper ? 'Hide KEEPER' : 'Show KEEPER'}
                    style={{
                        ...smvStyles.toggle,
                        right: showKeeper ? 348 : 8,
                    }}
                >
                    {showKeeper ? '\u25A8' : '\u25A7'}
                </button>
            </div>
        </div>
    );
}

// ─── Component Styles ───────────────────────────────────────
const smvStyles = {
    root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'transparent',
    },
    header: {
        padding: '12px 24px',
        borderBottom: '1px solid rgba(20, 184, 166, 0.1)',
        background: 'rgba(10, 10, 20, 0.8)',
        backdropFilter: 'blur(10px)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
    },
    titleRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
    },
    title: {
        margin: 0,
        fontSize: 18,
        fontWeight: 700,
        color: 'rgba(255,255,255,0.95)',
    },
    version: {
        fontSize: 12,
        color: 'rgba(20, 184, 166, 0.7)',
        fontWeight: 600,
        padding: '2px 8px',
        background: 'rgba(20, 184, 166, 0.08)',
        borderRadius: 4,
        fontVariantNumeric: 'tabular-nums',
    },
    tabBar: {
        display: 'flex',
        gap: 2,
        background: 'rgba(255,255,255,0.04)',
        borderRadius: 6,
        padding: 2,
    },
    tab: {
        padding: '6px 14px',
        background: 'none',
        border: 'none',
        borderRadius: 4,
        color: 'rgba(255,255,255,0.5)',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
        transition: 'all 0.15s',
    },
    tabActive: {
        background: 'rgba(20, 184, 166, 0.15)',
        color: 'rgba(20, 184, 166, 0.95)',
    },
    body: {
        display: 'flex',
        flex: 1,
        minHeight: 0,
        position: 'relative',
    },
    toggle: {
        position: 'absolute',
        top: 8,
        zIndex: 10,
        width: 30,
        height: 30,
        borderRadius: 6,
        border: '1px solid rgba(255,255,255,0.1)',
        background: 'rgba(255, 255, 255, 0.05)',
        color: 'rgba(255,255,255,0.6)',
        fontSize: 16,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 0.15s',
        backdropFilter: 'blur(8px)',
    },
};

export default SystemMaintenanceView;
