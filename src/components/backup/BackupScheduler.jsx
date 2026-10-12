/**
 * Backup Scheduler Component
 * Manages backup schedules for automated backups.
 */

import { useState } from 'react'

/**
 * Schedule card component
 */
function ScheduleCard({ schedule, onEdit, onDelete, onToggle }) {
    const getScheduleDescription = () => {
        switch (schedule.schedule_type) {
            case 'hourly':
                return `Every hour at :${String(schedule.schedule_minute || 0).padStart(2, '0')}`
            case 'daily':
                return `Daily at ${String(schedule.schedule_hour || 2).padStart(2, '0')}:${String(schedule.schedule_minute || 0).padStart(2, '0')}`
            case 'weekly':
                const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
                return `Every ${days[schedule.schedule_day_of_week || 0]} at ${String(schedule.schedule_hour || 2).padStart(2, '0')}:${String(schedule.schedule_minute || 0).padStart(2, '0')}`
            case 'monthly':
                return `Monthly on day ${schedule.schedule_day_of_month || 1} at ${String(schedule.schedule_hour || 2).padStart(2, '0')}:${String(schedule.schedule_minute || 0).padStart(2, '0')}`
            default:
                return schedule.cron_expression || 'Custom schedule'
        }
    }

    return (
        <div className={`schedule-card ${schedule.enabled ? '' : 'disabled'}`}>
            <div className="schedule-card-header">
                <div className="schedule-info">
                    <span className="schedule-name">{schedule.name}</span>
                    <span className="schedule-description">{getScheduleDescription()}</span>
                </div>
                <label className="schedule-toggle">
                    <input
                        type="checkbox"
                        checked={schedule.enabled}
                        onChange={(e) => onToggle(schedule.id, e.target.checked)}
                    />
                    <span className="schedule-toggle-slider"></span>
                </label>
            </div>

            <div className="schedule-card-meta">
                <span className="schedule-type-badge">{schedule.backup_type}</span>
                <span className="schedule-retention">
                    Keep {schedule.max_backups} backups / {schedule.retention_days} days
                </span>
            </div>

            {schedule.last_run_at && (
                <div className="schedule-last-run">
                    Last run: {new Date(schedule.last_run_at).toLocaleString()}
                    {schedule.last_status && (
                        <span className={`schedule-last-status ${schedule.last_status}`}>
                            {schedule.last_status}
                        </span>
                    )}
                </div>
            )}

            {schedule.next_run_at && schedule.enabled && (
                <div className="schedule-next-run">
                    Next run: {new Date(schedule.next_run_at).toLocaleString()}
                </div>
            )}

            <div className="schedule-card-actions">
                <button onClick={() => onEdit(schedule)}>Edit</button>
                <button className="delete" onClick={() => onDelete(schedule.id)}>Delete</button>
            </div>
        </div>
    )
}

/**
 * Schedule editor modal
 */
function ScheduleEditor({ schedule, components, onSave, onCancel }) {
    const [form, setForm] = useState({
        name: schedule?.name || '',
        schedule_type: schedule?.schedule_type || 'daily',
        schedule_hour: schedule?.schedule_hour ?? 2,
        schedule_minute: schedule?.schedule_minute ?? 0,
        schedule_day_of_week: schedule?.schedule_day_of_week ?? 0,
        schedule_day_of_month: schedule?.schedule_day_of_month ?? 1,
        backup_type: schedule?.backup_type || 'full',
        retention_days: schedule?.retention_days ?? 30,
        max_backups: schedule?.max_backups ?? 10
    })
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState(null)

    const handleSubmit = async (e) => {
        e.preventDefault()
        setSaving(true)
        setError(null)
        try {
            await onSave(form)
        } catch (err) {
            setError(err.message)
            setSaving(false)
        }
    }

    return (
        <div className="schedule-editor-overlay" onClick={onCancel}>
            <div className="schedule-editor" onClick={e => e.stopPropagation()}>
                <h3>{schedule ? 'Edit Schedule' : 'New Schedule'}</h3>

                {error && (
                    <div className="backup-error" style={{ margin: '0 0 12px' }}>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                        </svg>
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label>Schedule Name</label>
                        <input
                            type="text"
                            value={form.name}
                            onChange={e => setForm({ ...form, name: e.target.value })}
                            placeholder="e.g., Daily Backup"
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label>Frequency</label>
                        <select
                            value={form.schedule_type}
                            onChange={e => setForm({ ...form, schedule_type: e.target.value })}
                        >
                            <option value="hourly">Hourly</option>
                            <option value="daily">Daily</option>
                            <option value="weekly">Weekly</option>
                            <option value="monthly">Monthly</option>
                        </select>
                    </div>

                    <div className="form-row">
                        <div className="form-group">
                            <label>Hour</label>
                            <input
                                type="number"
                                min="0"
                                max="23"
                                value={form.schedule_hour}
                                onChange={e => setForm({ ...form, schedule_hour: parseInt(e.target.value) })}
                            />
                        </div>
                        <div className="form-group">
                            <label>Minute</label>
                            <input
                                type="number"
                                min="0"
                                max="59"
                                value={form.schedule_minute}
                                onChange={e => setForm({ ...form, schedule_minute: parseInt(e.target.value) })}
                            />
                        </div>
                    </div>

                    {form.schedule_type === 'weekly' && (
                        <div className="form-group">
                            <label>Day of Week</label>
                            <select
                                value={form.schedule_day_of_week}
                                onChange={e => setForm({ ...form, schedule_day_of_week: parseInt(e.target.value) })}
                            >
                                <option value={0}>Sunday</option>
                                <option value={1}>Monday</option>
                                <option value={2}>Tuesday</option>
                                <option value={3}>Wednesday</option>
                                <option value={4}>Thursday</option>
                                <option value={5}>Friday</option>
                                <option value={6}>Saturday</option>
                            </select>
                        </div>
                    )}

                    {form.schedule_type === 'monthly' && (
                        <div className="form-group">
                            <label>Day of Month</label>
                            <input
                                type="number"
                                min="1"
                                max="28"
                                value={form.schedule_day_of_month}
                                onChange={e => setForm({ ...form, schedule_day_of_month: parseInt(e.target.value) })}
                            />
                        </div>
                    )}

                    <div className="form-group">
                        <label>Backup Type</label>
                        <select
                            value={form.backup_type}
                            onChange={e => setForm({ ...form, backup_type: e.target.value })}
                        >
                            <option value="full">Full Backup</option>
                            <option value="quick">Quick Backup</option>
                        </select>
                    </div>

                    <div className="form-row">
                        <div className="form-group">
                            <label>Retention (days)</label>
                            <input
                                type="number"
                                min="1"
                                max="365"
                                value={form.retention_days}
                                onChange={e => setForm({ ...form, retention_days: parseInt(e.target.value) })}
                            />
                        </div>
                        <div className="form-group">
                            <label>Max Backups</label>
                            <input
                                type="number"
                                min="1"
                                max="100"
                                value={form.max_backups}
                                onChange={e => setForm({ ...form, max_backups: parseInt(e.target.value) })}
                            />
                        </div>
                    </div>

                    <div className="form-actions">
                        <button type="button" onClick={onCancel}>Cancel</button>
                        <button type="submit" disabled={saving}>
                            {saving ? 'Saving...' : 'Save Schedule'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    )
}

/**
 * Backup Scheduler component
 */
export function BackupScheduler({ schedules, components, onUpdate, svc }) {
    const [editingSchedule, setEditingSchedule] = useState(null)
    const [showEditor, setShowEditor] = useState(false)
    const [settingUpDefaults, setSettingUpDefaults] = useState(false)
    const [error, setError] = useState(null)

    const handleCreate = () => {
        setEditingSchedule(null)
        setShowEditor(true)
    }

    const handleEdit = (schedule) => {
        setEditingSchedule(schedule)
        setShowEditor(true)
    }

    const handleSave = async (form) => {
        if (!svc) throw new Error('Backup service not available')
        if (editingSchedule) {
            await svc.updateSchedule(editingSchedule.id, form)
        } else {
            await svc.createSchedule(form)
        }
        setShowEditor(false)
        setEditingSchedule(null)
        onUpdate()
    }

    const handleDelete = async (scheduleId) => {
        if (!svc) return
        if (!window.confirm('Are you sure you want to delete this schedule?')) return
        try {
            await svc.deleteSchedule(scheduleId)
            onUpdate()
        } catch (err) {
            setError(err.message)
        }
    }

    const handleToggle = async (scheduleId, enabled) => {
        if (!svc) return
        try {
            await svc.updateSchedule(scheduleId, { enabled: enabled ? 1 : 0 })
            onUpdate()
        } catch (err) {
            setError(err.message)
        }
    }

    const handleSetupDefaults = async () => {
        if (!svc) return
        setSettingUpDefaults(true)
        setError(null)
        try {
            await svc.createSchedule({
                name: 'Daily Quick Backup',
                schedule_type: 'daily',
                schedule_hour: 2,
                schedule_minute: 0,
                backup_type: 'quick',
                retention_days: 30,
                max_backups: 30
            })
            await svc.createSchedule({
                name: 'Weekly Full Backup',
                schedule_type: 'weekly',
                schedule_hour: 3,
                schedule_minute: 0,
                schedule_day_of_week: 0,
                backup_type: 'full',
                retention_days: 90,
                max_backups: 12
            })
            onUpdate()
        } catch (err) {
            setError(err.message)
        } finally {
            setSettingUpDefaults(false)
        }
    }

    return (
        <div className="backup-scheduler">
            <div className="scheduler-header">
                <p>Configure automated backup schedules to protect your data.</p>
                <button className="create-schedule-btn" onClick={handleCreate}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    New Schedule
                </button>
            </div>

            {error && (
                <div className="backup-error" style={{ margin: '0 0 12px' }}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                    </svg>
                    {error}
                    <button onClick={() => setError(null)}>Dismiss</button>
                </div>
            )}

            {schedules.length === 0 ? (
                <div className="scheduler-empty">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.5">
                        <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                    </svg>
                    <h3>No Schedules</h3>
                    <p>Create a schedule to automate your backups.</p>
                    <button
                        className="setup-defaults-btn"
                        onClick={handleSetupDefaults}
                        disabled={settingUpDefaults}
                    >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/><path d="M12 13v7"/><polyline points="9 17 12 20 15 17"/>
                        </svg>
                        {settingUpDefaults ? 'Setting up...' : 'Set Up Recommended Schedules'}
                    </button>
                    <small className="setup-defaults-hint">
                        Creates: Daily Quick Backup (2 AM, 30-day retention) + Weekly Full Backup (Sunday 3 AM, 90-day retention)
                    </small>
                </div>
            ) : (
                <div className="schedule-list">
                    {schedules.map(schedule => (
                        <ScheduleCard
                            key={schedule.id}
                            schedule={schedule}
                            onEdit={handleEdit}
                            onDelete={handleDelete}
                            onToggle={handleToggle}
                        />
                    ))}
                </div>
            )}

            {showEditor && (
                <ScheduleEditor
                    schedule={editingSchedule}
                    components={components}
                    onSave={handleSave}
                    onCancel={() => {
                        setShowEditor(false)
                        setEditingSchedule(null)
                    }}
                />
            )}
        </div>
    )
}

export default BackupScheduler
