/**
 * BackupSettings - Settings panel for Backup & Restore configuration
 *
 * Provides quick access to backup management, schedule configuration,
 * and retention policy settings from within the Settings sidebar.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import SettingsSection from './SettingsSection';
import SettingsCard from './SettingsCard';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { createBackupService } from '../../services/backup/backupService';

const SCHEDULE_TYPES = [
    { value: 'hourly', label: 'Hourly' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' }
];

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function StatusDot({ status }) {
    const colors = {
        completed: '#10b981',
        running: '#f59e0b',
        failed: '#ef4444',
        success: '#10b981',
        verified: '#3b82f6'
    };
    return (
        <span style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: colors[status] || '#6b7280',
            marginRight: 6
        }} />
    );
}

function formatRelativeTime(iso) {
    if (!iso) return 'Never';
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const future = diffMs < 0;
    const absDiff = Math.abs(diffMs);
    const mins = Math.floor(absDiff / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);

    if (future) {
        if (mins < 60) return `in ${mins}m`;
        if (hours < 24) return `in ${hours}h`;
        return `in ${days}d`;
    }
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
}

export default function BackupSettings() {
    const navigate = useNavigate();
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();
    const [lastBackup, setLastBackup] = useState(null);
    const [schedules, setSchedules] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [successMsg, setSuccessMsg] = useState(null);

    const svc = useMemo(() => {
        if (!currentOrg?.id) return null;
        try { return createBackupService(authFetch, currentOrg.id); } catch { return null; }
    }, [authFetch, currentOrg?.id]);

    // Schedule form state
    const [scheduleForm, setScheduleForm] = useState({
        name: 'Default Schedule',
        schedule_type: 'daily',
        backup_type: 'quick',
        schedule_hour: 2,
        schedule_minute: 0,
        schedule_day_of_week: 0,
        schedule_day_of_month: 1,
        retention_days: 30,
        max_backups: 10,
        enabled: true
    });
    const [editingScheduleId, setEditingScheduleId] = useState(null);

    const loadData = useCallback(async () => {
        if (!svc) {
            setLoading(false);
            return;
        }
        try {
            setLoading(true);
            setError(null);

            const [backupsResult, schedulesResult] = await Promise.all([
                svc.listBackups({ limit: 1 }).catch(() => ({ items: [] })),
                svc.listSchedules().catch(() => [])
            ]);

            const backups = backupsResult.items || backupsResult.backups || [];
            if (backups.length > 0) {
                setLastBackup(backups[0]);
            }

            setSchedules(schedulesResult);

            // Pre-fill form from first schedule if one exists
            if (schedulesResult.length > 0) {
                const s = schedulesResult[0];
                setEditingScheduleId(s.id);
                setScheduleForm({
                    name: s.name || 'Default Schedule',
                    schedule_type: s.schedule_type || 'daily',
                    backup_type: s.backup_type || 'quick',
                    schedule_hour: s.schedule_hour ?? 2,
                    schedule_minute: s.schedule_minute ?? 0,
                    schedule_day_of_week: s.schedule_day_of_week ?? 0,
                    schedule_day_of_month: s.schedule_day_of_month ?? 1,
                    retention_days: s.retention_days ?? 30,
                    max_backups: s.max_backups ?? 10,
                    enabled: s.enabled === 1 || s.enabled === true
                });
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [svc]);

    useEffect(() => { loadData(); }, [loadData]);

    const showSuccess = (msg) => {
        setSuccessMsg(msg);
        setTimeout(() => setSuccessMsg(null), 3000);
    };

    const handleSaveSchedule = async () => {
        if (!svc) return;
        try {
            setSaving(true);
            setError(null);

            if (editingScheduleId) {
                await svc.updateSchedule(editingScheduleId, scheduleForm);
                showSuccess('Schedule updated');
            } else {
                const created = await svc.createSchedule(scheduleForm);
                setEditingScheduleId(created.id);
                showSuccess('Schedule created');
            }

            await loadData();
        } catch (err) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    const handleToggleEnabled = async () => {
        if (!svc) return;
        const newEnabled = !scheduleForm.enabled;
        setScheduleForm(prev => ({ ...prev, enabled: newEnabled }));

        if (editingScheduleId) {
            try {
                await svc.updateSchedule(editingScheduleId, { enabled: newEnabled });
                showSuccess(newEnabled ? 'Schedule enabled' : 'Schedule paused');
            } catch (err) {
                setError(err.message);
                setScheduleForm(prev => ({ ...prev, enabled: !newEnabled }));
            }
        }
    };

    const inputStyle = {
        width: '100%',
        padding: '8px 12px',
        background: 'rgba(0,0,0,0.2)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '6px',
        color: 'var(--ui-text-primary)',
        fontSize: '13px',
        outline: 'none'
    };

    const selectStyle = {
        ...inputStyle,
        cursor: 'pointer',
        appearance: 'none',
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%239ca3af' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 10px center',
        paddingRight: '30px'
    };

    const labelStyle = {
        display: 'block',
        fontSize: '12px',
        fontWeight: '500',
        color: 'var(--ui-text-secondary)',
        marginBottom: '4px'
    };

    const rowStyle = {
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '12px'
    };

    if (loading) {
        return (
            <SettingsSection title="Backup & Restore" description="Loading backup configuration...">
                <SettingsCard glass>
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--ui-text-muted)' }}>
                        Loading...
                    </div>
                </SettingsCard>
            </SettingsSection>
        );
    }

    return (
        <div>
            {/* Notifications */}
            {error && (
                <div style={{
                    padding: '10px 14px', marginBottom: '16px', borderRadius: '8px',
                    background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
                    color: '#fca5a5', fontSize: '13px'
                }}>
                    {error}
                </div>
            )}
            {successMsg && (
                <div style={{
                    padding: '10px 14px', marginBottom: '16px', borderRadius: '8px',
                    background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)',
                    color: '#6ee7b7', fontSize: '13px'
                }}>
                    {successMsg}
                </div>
            )}

            {/* Card 1: Quick Actions & Status */}
            <SettingsSection title="Backup & Restore" description="System backup status and quick actions">
                <SettingsCard glass>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {/* Last Backup Status */}
                        <div style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '12px 16px', borderRadius: '8px',
                            background: lastBackup ? 'rgba(16,185,129,0.08)' : 'rgba(107,114,128,0.08)',
                            border: `1px solid ${lastBackup ? 'rgba(16,185,129,0.2)' : 'rgba(107,114,128,0.2)'}`
                        }}>
                            <div>
                                <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--ui-text-primary)', marginBottom: '2px' }}>
                                    {lastBackup ? (
                                        <>
                                            <StatusDot status={lastBackup.status} />
                                            Last backup: {lastBackup.name || lastBackup.backup_type}
                                        </>
                                    ) : 'No backups yet'}
                                </div>
                                <div style={{ fontSize: '12px', color: 'var(--ui-text-muted)' }}>
                                    {lastBackup ? formatRelativeTime(lastBackup.completed_at || lastBackup.created_at) : 'Create your first backup from the Backup Manager'}
                                </div>
                            </div>
                            {lastBackup?.archive_size_bytes && (
                                <span style={{ fontSize: '12px', color: 'var(--ui-text-muted)', whiteSpace: 'nowrap' }}>
                                    {(lastBackup.archive_size_bytes / 1024 / 1024).toFixed(1)} MB
                                </span>
                            )}
                        </div>

                        {/* Next Scheduled Run */}
                        {schedules.length > 0 && schedules[0].next_run_at && (
                            <div style={{
                                display: 'flex', alignItems: 'center', gap: '8px',
                                fontSize: '12px', color: 'var(--ui-text-muted)'
                            }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="12" r="10" />
                                    <polyline points="12 6 12 12 16 14" />
                                </svg>
                                Next scheduled: {formatRelativeTime(schedules[0].next_run_at)}
                                {!schedules[0].enabled && <span style={{ color: '#f59e0b' }}>(paused)</span>}
                            </div>
                        )}

                        {/* Actions */}
                        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                            <Button variant="primary" onClick={() => navigate('/backup')}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}>
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                    <polyline points="7 10 12 15 17 10" />
                                    <line x1="12" y1="15" x2="12" y2="3" />
                                </svg>
                                Open Backup Manager
                            </Button>
                            <Button variant="secondary" onClick={() => navigate('/activity')}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}>
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                    <polyline points="14 2 14 8 20 8" />
                                    <line x1="16" y1="13" x2="8" y2="13" />
                                    <line x1="16" y1="17" x2="8" y2="17" />
                                </svg>
                                View Activity Log
                            </Button>
                        </div>
                    </div>
                </SettingsCard>
            </SettingsSection>

            {/* Card 2: Schedule Configuration */}
            <SettingsSection title="Backup Schedule" description="Configure automatic backup scheduling">
                <SettingsCard glass>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {/* Enable toggle */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div>
                                <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--ui-text-primary)' }}>
                                    Automatic Backups
                                </div>
                                <div style={{ fontSize: '12px', color: 'var(--ui-text-muted)' }}>
                                    {scheduleForm.enabled ? 'Backups run on schedule' : 'Schedule is paused'}
                                </div>
                            </div>
                            <button
                                onClick={handleToggleEnabled}
                                style={{
                                    width: '44px', height: '24px', borderRadius: '12px', border: 'none',
                                    background: scheduleForm.enabled ? '#10b981' : 'rgba(107,114,128,0.4)',
                                    cursor: 'pointer', position: 'relative', transition: 'background 0.2s'
                                }}
                            >
                                <span style={{
                                    position: 'absolute', top: '2px',
                                    left: scheduleForm.enabled ? '22px' : '2px',
                                    width: '20px', height: '20px', borderRadius: '50%',
                                    background: '#fff', transition: 'left 0.2s',
                                    boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
                                }} />
                            </button>
                        </div>

                        {/* Schedule Name */}
                        <div>
                            <label style={labelStyle}>Schedule Name</label>
                            <input
                                style={inputStyle}
                                value={scheduleForm.name}
                                onChange={e => setScheduleForm(p => ({ ...p, name: e.target.value }))}
                                placeholder="e.g. Nightly Backup"
                            />
                        </div>

                        {/* Frequency + Backup Type */}
                        <div style={rowStyle}>
                            <div>
                                <label style={labelStyle}>Frequency</label>
                                <select
                                    style={selectStyle}
                                    value={scheduleForm.schedule_type}
                                    onChange={e => setScheduleForm(p => ({ ...p, schedule_type: e.target.value }))}
                                >
                                    {SCHEDULE_TYPES.map(t => (
                                        <option key={t.value} value={t.value}>{t.label}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label style={labelStyle}>Backup Type</label>
                                <select
                                    style={selectStyle}
                                    value={scheduleForm.backup_type}
                                    onChange={e => setScheduleForm(p => ({ ...p, backup_type: e.target.value }))}
                                >
                                    <option value="quick">Quick</option>
                                    <option value="full">Full</option>
                                </select>
                            </div>
                        </div>

                        {/* Time */}
                        <div style={rowStyle}>
                            <div>
                                <label style={labelStyle}>Hour (0-23)</label>
                                <input
                                    type="number"
                                    min="0"
                                    max="23"
                                    style={inputStyle}
                                    value={scheduleForm.schedule_hour}
                                    onChange={e => setScheduleForm(p => ({ ...p, schedule_hour: parseInt(e.target.value) || 0 }))}
                                />
                            </div>
                            <div>
                                <label style={labelStyle}>Minute (0-59)</label>
                                <input
                                    type="number"
                                    min="0"
                                    max="59"
                                    style={inputStyle}
                                    value={scheduleForm.schedule_minute}
                                    onChange={e => setScheduleForm(p => ({ ...p, schedule_minute: parseInt(e.target.value) || 0 }))}
                                />
                            </div>
                        </div>

                        {/* Day of Week (for weekly) */}
                        {scheduleForm.schedule_type === 'weekly' && (
                            <div>
                                <label style={labelStyle}>Day of Week</label>
                                <select
                                    style={selectStyle}
                                    value={scheduleForm.schedule_day_of_week}
                                    onChange={e => setScheduleForm(p => ({ ...p, schedule_day_of_week: parseInt(e.target.value) }))}
                                >
                                    {DAYS_OF_WEEK.map((day, i) => (
                                        <option key={i} value={i}>{day}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Day of Month (for monthly) */}
                        {scheduleForm.schedule_type === 'monthly' && (
                            <div>
                                <label style={labelStyle}>Day of Month (1-28)</label>
                                <input
                                    type="number"
                                    min="1"
                                    max="28"
                                    style={inputStyle}
                                    value={scheduleForm.schedule_day_of_month}
                                    onChange={e => setScheduleForm(p => ({ ...p, schedule_day_of_month: parseInt(e.target.value) || 1 }))}
                                />
                            </div>
                        )}

                        {/* Save button */}
                        <Button variant="primary" onClick={handleSaveSchedule} disabled={saving}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}>
                                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                                <polyline points="17 21 17 13 7 13 7 21" />
                                <polyline points="7 3 7 8 15 8" />
                            </svg>
                            {saving ? 'Saving...' : (editingScheduleId ? 'Update Schedule' : 'Create Schedule')}
                        </Button>
                    </div>
                </SettingsCard>
            </SettingsSection>

            {/* Card 3: Retention Policy */}
            <SettingsSection title="Retention Policy" description="Configure how long backups are kept">
                <SettingsCard glass>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        <div style={rowStyle}>
                            <div>
                                <label style={labelStyle}>Retention Days</label>
                                <input
                                    type="number"
                                    min="1"
                                    max="365"
                                    style={inputStyle}
                                    value={scheduleForm.retention_days}
                                    onChange={e => setScheduleForm(p => ({ ...p, retention_days: parseInt(e.target.value) || 30 }))}
                                />
                                <div style={{ fontSize: '11px', color: 'var(--ui-text-muted)', marginTop: '4px' }}>
                                    Backups older than this are automatically deleted
                                </div>
                            </div>
                            <div>
                                <label style={labelStyle}>Max Backups</label>
                                <input
                                    type="number"
                                    min="1"
                                    max="100"
                                    style={inputStyle}
                                    value={scheduleForm.max_backups}
                                    onChange={e => setScheduleForm(p => ({ ...p, max_backups: parseInt(e.target.value) || 10 }))}
                                />
                                <div style={{ fontSize: '11px', color: 'var(--ui-text-muted)', marginTop: '4px' }}>
                                    Oldest backups pruned when limit exceeded
                                </div>
                            </div>
                        </div>

                        <div style={{
                            padding: '10px 14px', borderRadius: '8px',
                            background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.15)',
                            fontSize: '12px', color: 'var(--ui-text-secondary)'
                        }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginRight: '6px' }}>
                                <circle cx="12" cy="12" r="10" />
                                <line x1="12" y1="16" x2="12" y2="12" />
                                <line x1="12" y1="8" x2="12.01" y2="8" />
                            </svg>
                            Retention is enforced automatically after each scheduled backup completes.
                            Changes here apply when you save the schedule above.
                        </div>
                    </div>
                </SettingsCard>
            </SettingsSection>
        </div>
    );
}
