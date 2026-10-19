/**
 * QuoxCORE Backup Panel
 *
 * Main backup management interface with tabs for:
 * - Backup history
 * - Scheduled backups
 * - Component selection
 * - Audit log
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import {
    createBackupService,
    formatBytes,
    pollForCompletion
} from '../../services/backup/backupService'
import { useBackupStatus } from '../../hooks/useBackupStatus'
import { DEFCON_COLORS } from '../../services/backup/backupIntents'
import { BackupHistory } from './BackupHistory'
import { BackupProgress } from './BackupProgress'
import { ComponentSelector } from './ComponentSelector'
import { BackupScheduler } from './BackupScheduler'
import { RestoreWizard } from './RestoreWizard'
import { BackupAuditLog } from './BackupAuditLog'
import './backup.css'

/**
 * Health dot color mapping
 */
const HEALTH_COLORS = {
    healthy: '#10b981',
    warning: '#f59e0b',
    critical: '#ef4444',
    unknown: '#6b7280'
}

/**
 * Relative time formatter
 */
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

/**
 * Status banner showing backup health at a glance
 */
function BackupStatusBanner({ status, error }) {
    // Show error state when backup status can't be fetched
    if (error && !status) {
        return (
            <div className="backup-status-banner" style={{ borderLeftColor: HEALTH_COLORS.critical }}>
                <div className="backup-status-banner-health">
                    <span className="backup-health-dot" style={{ background: HEALTH_COLORS.critical }} />
                    <span className="backup-health-label" style={{ color: HEALTH_COLORS.critical }}>
                        Error
                    </span>
                    <span className="backup-health-reason">Could not fetch backup status</span>
                </div>
            </div>
        )
    }

    if (!status) return null

    const health = status.health || 'unknown'
    const color = HEALTH_COLORS[health]

    return (
        <div className="backup-status-banner" style={{ borderLeftColor: color }}>
            <div className="backup-status-banner-health">
                <span className="backup-health-dot" style={{ background: color }} />
                <span className="backup-health-label" style={{ color }}>
                    {health === 'healthy' ? 'Healthy' : health === 'warning' ? 'Warning' : health === 'critical' ? 'Critical' : 'Unknown'}
                </span>
                <span className="backup-health-reason">{status.healthReason}</span>
            </div>

            <div className="backup-status-banner-stats">
                <span className="backup-status-stat">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 12a9 9 0 11-6.22-8.56"/><path d="M21 3v6h-6"/>
                    </svg>
                    Last: {timeAgo(status.lastSuccess?.completedAt)}
                </span>
                <span className="backup-status-stat">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/>
                    </svg>
                    {status.totals?.count || 0} backups ({formatBytes(status.totals?.totalBytes || 0)})
                </span>
                <span className="backup-status-stat">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                    </svg>
                    {status.totals?.storagePath || '~/backups'}
                </span>
                {status.schedules?.nextRun && (
                    <span className="backup-status-stat">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                        </svg>
                        Next: {new Date(status.schedules.nextRun).toLocaleString()}
                    </span>
                )}
                {status.running && (
                    <span className="backup-status-stat backup-status-running">
                        <span className="backup-spinner" style={{ width: 12, height: 12 }} />
                        Running: {status.running.name}
                    </span>
                )}
            </div>
        </div>
    )
}

/**
 * Restore Validation Checklist
 * Runs server-side checks to verify all components are healthy after a restore.
 */
function RestoreValidation({ checks, loading, onRerun }) {
    if (loading) {
        return (
            <div className="backup-validation">
                <div className="backup-validation-loading">
                    <span className="backup-spinner" />
                    <span>Running validation checks...</span>
                </div>
            </div>
        )
    }

    if (!checks) {
        return (
            <div className="backup-validation">
                <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>
                    Click the tab to run validation checks against the current instance.
                </p>
            </div>
        )
    }

    const statusIcon = (status) => {
        if (status === 'pass') return <span style={{ color: '#10b981', fontSize: 16 }}>&#10003;</span>
        if (status === 'warn') return <span style={{ color: '#f59e0b', fontSize: 16 }}>&#9888;</span>
        return <span style={{ color: '#ef4444', fontSize: 16 }}>&#10007;</span>
    }

    const summaryColor = checks.summary?.overall === 'pass' ? '#10b981'
        : checks.summary?.overall === 'warn' ? '#f59e0b' : '#ef4444'

    return (
        <div className="backup-validation">
            <div className="backup-validation-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="backup-health-dot" style={{ background: summaryColor, width: 10, height: 10 }} />
                    <strong style={{ color: summaryColor, fontSize: 14 }}>
                        {checks.summary?.overall === 'pass' ? 'All Checks Passed' :
                         checks.summary?.overall === 'warn' ? 'Passed with Warnings' : 'Issues Detected'}
                    </strong>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
                    <span style={{ color: '#10b981' }}>{checks.summary?.pass || 0} pass</span>
                    <span style={{ color: '#f59e0b' }}>{checks.summary?.warn || 0} warn</span>
                    <span style={{ color: '#ef4444' }}>{checks.summary?.fail || 0} fail</span>
                    <button className="backup-validation-rerun" onClick={onRerun} title="Re-run validation">
                        &#8635;
                    </button>
                </div>
            </div>
            <div className="backup-validation-list">
                {(checks.checks || []).map((check, i) => (
                    <div key={i} className={`backup-validation-item backup-validation-item--${check.status}`}>
                        <span className="backup-validation-icon">{statusIcon(check.status)}</span>
                        <span className="backup-validation-label">{check.label}</span>
                        <span className="backup-validation-detail">{check.detail}</span>
                    </div>
                ))}
            </div>
            {checks.timestamp && (
                <div className="backup-validation-ts">
                    Last checked: {new Date(checks.timestamp).toLocaleString()}
                </div>
            )}
        </div>
    )
}

/**
 * Main Backup Panel component
 */
export function BackupPanel({ onStateChange }) {
    const { authFetch } = useAuth()
    const { currentOrg } = useWorkspace()

    // State
    const [activeTab, setActiveTab] = useState('history')
    const [backups, setBackups] = useState([])
    const [components, setComponents] = useState([])
    const [schedules, setSchedules] = useState([])
    const [auditEntries, setAuditEntries] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)

    // Backup creation state
    const [isCreating, setIsCreating] = useState(false)
    const [activeBackup, setActiveBackup] = useState(null)
    const [selectedComponents, setSelectedComponents] = useState([])
    const [backupType, setBackupType] = useState('full')

    // Backup health status
    const { status: backupStatus, error: statusError } = useBackupStatus()

    // Restore wizard state
    const [restoreWizardOpen, setRestoreWizardOpen] = useState(false)
    const [selectedBackupForRestore, setSelectedBackupForRestore] = useState(null)

    // Scan/import state
    const [isScanning, setIsScanning] = useState(false)

    // Create bound service instance when org changes
    const svc = useMemo(() => {
        if (!currentOrg?.id) return null
        try {
            return createBackupService(authFetch, currentOrg.id)
        } catch {
            return null
        }
    }, [authFetch, currentOrg?.id])

    // Report state to parent (for sidebar context)
    useEffect(() => {
        if (onStateChange) {
            onStateChange({ backups, schedules, components, selectedBackup: selectedBackupForRestore })
        }
    }, [backups, schedules, components, selectedBackupForRestore, onStateChange])

    // Load data on mount / org change
    useEffect(() => {
        if (svc) loadData()
    }, [svc])

    // Load all data
    const loadData = useCallback(async () => {
        if (!svc) return
        setLoading(true)
        setError(null)

        try {
            const [backupsResult, componentsResult, schedulesResult] = await Promise.all([
                svc.listBackups({ limit: 50 }),
                svc.getBackupComponents(),
                svc.listSchedules()
            ])

            setBackups(backupsResult.items || [])
            setComponents(componentsResult)
            setSchedules(schedulesResult)

            // Set default selected components (all enabled by default)
            const defaultEnabled = componentsResult
                .filter(c => c.defaultEnabled)
                .map(c => c.component_key)
            setSelectedComponents(defaultEnabled)

        } catch (err) {
            console.error('Failed to load backup data:', err)
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }, [svc])

    // Validation state
    const [validationChecks, setValidationChecks] = useState(null)
    const [validationLoading, setValidationLoading] = useState(false)

    // Load audit log or validation when tab changes
    useEffect(() => {
        if (activeTab === 'audit' && svc) {
            loadAuditLog()
        }
        if (activeTab === 'validation' && svc && !validationChecks) {
            runValidation()
        }
    }, [activeTab, svc])

    const loadAuditLog = async () => {
        if (!svc) return
        try {
            const result = await svc.getAuditLog({ limit: 100 })
            setAuditEntries(result.items || [])
        } catch (err) {
            console.error('Failed to load audit log:', err)
        }
    }

    const runValidation = async () => {
        if (!svc) return
        setValidationLoading(true)
        try {
            const result = await svc.validateRestore()
            setValidationChecks(result)
        } catch (err) {
            console.error('Validation failed:', err)
            setError('Validation check failed: ' + err.message)
        } finally {
            setValidationLoading(false)
        }
    }

    // Create backup
    const handleCreateBackup = async () => {
        if (!svc) return
        setIsCreating(true)
        setError(null)

        try {
            const options = {
                backup_type: backupType,
                name: `${backupType.charAt(0).toUpperCase() + backupType.slice(1)} Backup - ${new Date().toLocaleString()}`,
                components: backupType === 'selective' ? selectedComponents : undefined
            }

            const backup = await svc.createBackup(options)
            setActiveBackup(backup)

            // Poll for completion
            await pollForCompletion(
                () => svc.getBackup(backup.id),
                (status) => setActiveBackup(status),
                2000,
                600000
            )

            // Reload backups list
            await loadData()

        } catch (err) {
            console.error('Backup failed:', err)
            setError(err.message)
        } finally {
            setIsCreating(false)
            setActiveBackup(null)
        }
    }

    // Delete backup
    const handleDeleteBackup = async (backupId) => {
        if (!svc) return
        if (!window.confirm('Are you sure you want to delete this backup? This action cannot be undone.')) {
            return
        }

        try {
            await svc.deleteBackup(backupId)
            setBackups(prev => prev.filter(b => b.id !== backupId))
        } catch (err) {
            console.error('Failed to delete backup:', err)
            setError(err.message)
        }
    }

    // Verify backup
    const handleVerifyBackup = async (backupId) => {
        if (!svc) return
        try {
            await svc.verifyBackup(backupId)
            // Poll for verification completion
            await pollForCompletion(
                () => svc.getBackup(backupId),
                (status) => {
                    setBackups(prev => prev.map(b =>
                        b.id === backupId ? { ...b, ...status } : b
                    ))
                },
                1000,
                60000
            )
        } catch (err) {
            console.error('Verification failed:', err)
            setError(err.message)
        }
    }

    // Open restore wizard
    const handleRestoreBackup = (backup) => {
        setSelectedBackupForRestore(backup)
        setRestoreWizardOpen(true)
    }

    // Scan backup directory for importable archives
    const handleScanForBackups = async () => {
        if (!svc) return
        setIsScanning(true)
        setError(null)

        try {
            const result = await svc.scanForBackups()
            if (result.imported > 0) {
                await loadData()
            }
            if (result.imported === 0 && result.totalScanned === 0) {
                setError('No backup archives found in ' + (backupStatus?.totals?.storagePath || '~/backups'))
            }
        } catch (err) {
            console.error('Scan failed:', err)
            setError('Scan failed: ' + err.message)
        } finally {
            setIsScanning(false)
        }
    }

    // No org selected — show helpful message
    if (!currentOrg?.id) {
        return (
            <div className="backup-panel">
                <div className="backup-header">
                    <div className="backup-title">
                        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/><path d="M12 13v7"/><polyline points="9 17 12 20 15 17"/>
                        </svg>
                        <h2>Backup & Restore</h2>
                    </div>
                </div>
                <div className="backup-error">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                    </svg>
                    No organization selected. Please select an organization from Settings to manage backups.
                </div>
            </div>
        )
    }

    // Render tabs
    const renderTabs = () => (
        <div className="backup-tabs">
            <button
                className={`backup-tab ${activeTab === 'history' ? 'active' : ''}`}
                onClick={() => setActiveTab('history')}
            >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                History
            </button>
            <button
                className={`backup-tab ${activeTab === 'schedule' ? 'active' : ''}`}
                onClick={() => setActiveTab('schedule')}
            >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
                Schedule
            </button>
            <button
                className={`backup-tab ${activeTab === 'components' ? 'active' : ''}`}
                onClick={() => setActiveTab('components')}
            >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                </svg>
                Components
            </button>
            <button
                className={`backup-tab ${activeTab === 'audit' ? 'active' : ''}`}
                onClick={() => setActiveTab('audit')}
            >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
                </svg>
                Audit Log
            </button>
            <button
                className={`backup-tab ${activeTab === 'validation' ? 'active' : ''}`}
                onClick={() => setActiveTab('validation')}
            >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
                Validation
            </button>
        </div>
    )

    // Render backup creation controls
    const renderCreateControls = () => (
        <div className="backup-create-section">
            <div className="backup-type-selector">
                <label className="backup-type-option">
                    <input
                        type="radio"
                        name="backupType"
                        value="full"
                        checked={backupType === 'full'}
                        onChange={() => setBackupType('full')}
                        disabled={isCreating}
                    />
                    <span className="backup-type-label">
                        <strong>Full Backup</strong>
                        <small>All components (~{formatBytes(components.reduce((sum, c) => sum + (c.estimated_size_bytes || 0), 0))})</small>
                    </span>
                </label>
                <label className="backup-type-option">
                    <input
                        type="radio"
                        name="backupType"
                        value="quick"
                        checked={backupType === 'quick'}
                        onChange={() => setBackupType('quick')}
                        disabled={isCreating}
                    />
                    <span className="backup-type-label">
                        <strong>Quick Backup</strong>
                        <small>Data only, no git repos</small>
                    </span>
                </label>
                <label className="backup-type-option">
                    <input
                        type="radio"
                        name="backupType"
                        value="selective"
                        checked={backupType === 'selective'}
                        onChange={() => setBackupType('selective')}
                        disabled={isCreating}
                    />
                    <span className="backup-type-label">
                        <strong>Selective</strong>
                        <small>Choose components</small>
                    </span>
                </label>
            </div>

            <button
                className="backup-create-btn"
                onClick={handleCreateBackup}
                disabled={isCreating || (backupType === 'selective' && selectedComponents.length === 0)}
            >
                {isCreating ? (
                    <>
                        <span className="backup-spinner"></span>
                        Creating Backup...
                    </>
                ) : (
                    <>
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                        Create Backup
                    </>
                )}
            </button>
        </div>
    )

    // Render tab content
    const renderTabContent = () => {
        switch (activeTab) {
            case 'history':
                return (
                    <BackupHistory
                        backups={backups}
                        onDelete={handleDeleteBackup}
                        onVerify={handleVerifyBackup}
                        onRestore={handleRestoreBackup}
                        onScan={handleScanForBackups}
                        scanning={isScanning}
                        loading={loading}
                    />
                )
            case 'schedule':
                return (
                    <BackupScheduler
                        schedules={schedules}
                        components={components}
                        onUpdate={loadData}
                        svc={svc}
                    />
                )
            case 'components':
                return (
                    <ComponentSelector
                        components={components}
                        selected={selectedComponents}
                        onChange={setSelectedComponents}
                        disabled={isCreating}
                    />
                )
            case 'audit':
                return (
                    <BackupAuditLog
                        entries={auditEntries}
                        onRefresh={loadAuditLog}
                    />
                )
            case 'validation':
                return (
                    <RestoreValidation
                        checks={validationChecks}
                        loading={validationLoading}
                        onRerun={runValidation}
                    />
                )
            default:
                return null
        }
    }

    return (
        <div className="backup-panel">
            {/* Header */}
            <div className="backup-header">
                <div className="backup-title">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/><path d="M12 13v7"/><polyline points="9 17 12 20 15 17"/>
                    </svg>
                    <h2>Backup & Restore</h2>
                </div>
                <div className="backup-stats">
                    <span className="backup-stat">
                        <strong>{backups.length}</strong> backups
                    </span>
                    <span className="backup-stat">
                        <strong>{schedules.filter(s => s.enabled).length}</strong> active schedules
                    </span>
                </div>
            </div>

            {/* Status Banner */}
            <BackupStatusBanner status={backupStatus} error={statusError} />

            {/* Error display */}
            {error && (
                <div className="backup-error">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                    </svg>
                    {error}
                    <button onClick={() => setError(null)}>Dismiss</button>
                </div>
            )}

            {/* Progress display */}
            {activeBackup && (
                <BackupProgress backup={activeBackup} />
            )}

            {/* Create controls */}
            {renderCreateControls()}

            {/* Tabs */}
            {renderTabs()}

            {/* Tab content */}
            <div className="backup-tab-content">
                {renderTabContent()}
            </div>

            {/* Restore wizard modal */}
            {restoreWizardOpen && selectedBackupForRestore && (
                <RestoreWizard
                    backup={selectedBackupForRestore}
                    components={components}
                    onClose={() => {
                        setRestoreWizardOpen(false)
                        setSelectedBackupForRestore(null)
                    }}
                    onComplete={loadData}
                />
            )}
        </div>
    )
}

export default BackupPanel
