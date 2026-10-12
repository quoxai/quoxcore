/**
 * Restore Wizard Component
 * Multi-step wizard for restoring from backups.
 */

import { useState, useEffect } from 'react'
import { formatBytes, pollForCompletion } from '../../services/backup/backupService'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { createBackupService } from '../../services/backup/backupService'
import { RestoreProgress } from './RestoreProgress'

const STEPS = ['Select Components', 'Review', 'Confirm', 'Restore']

/**
 * Step indicator
 */
function StepIndicator({ currentStep, steps }) {
    return (
        <div className="restore-steps">
            {steps.map((step, index) => (
                <div
                    key={step}
                    className={`restore-step ${index <= currentStep ? 'active' : ''} ${index < currentStep ? 'completed' : ''}`}
                >
                    <span className="step-number">{index + 1}</span>
                    <span className="step-label">{step}</span>
                </div>
            ))}
        </div>
    )
}

/**
 * Restore Wizard component
 */
export function RestoreWizard({ backup, components, onClose, onComplete }) {
    const { authFetch } = useAuth()
    const { currentOrg } = useWorkspace()
    const [step, setStep] = useState(0)
    const [selectedComponents, setSelectedComponents] = useState([])
    const [dryRun, setDryRun] = useState(true)
    const [restoreOperation, setRestoreOperation] = useState(null)
    const [error, setError] = useState(null)
    const [isRestoring, setIsRestoring] = useState(false)
    const [activeRestoreId, setActiveRestoreId] = useState(null)
    const [comparison, setComparison] = useState(null)
    const [comparisonLoading, setComparisonLoading] = useState(false)
    const [isRollingBack, setIsRollingBack] = useState(false)
    const [rollbackResult, setRollbackResult] = useState(null)

    // Fetch comparison data on mount
    useEffect(() => {
        if (currentOrg?.id && backup?.id) {
            setComparisonLoading(true)
            const svc = createBackupService(authFetch, currentOrg.id)
            svc.compareBackup(backup.id)
                .then(data => setComparison(data))
                .catch(err => console.warn('Comparison failed:', err))
                .finally(() => setComparisonLoading(false))
        }
    }, [backup?.id])

    // Get backup components or all available
    const backupComponents = backup.components?.length > 0
        ? components.filter(c => backup.components.includes(c.component_key))
        : components

    const handleComponentToggle = (key) => {
        if (selectedComponents.includes(key)) {
            setSelectedComponents(prev => prev.filter(k => k !== key))
        } else {
            setSelectedComponents(prev => [...prev, key])
        }
    }

    const handleRestore = async () => {
        setIsRestoring(true)
        setError(null)

        try {
            const svc = createBackupService(authFetch, currentOrg?.id)
            const result = await svc.restoreBackup(backup.id, {
                dry_run: dryRun,
                components: selectedComponents.length > 0 ? selectedComponents : null
            })

            setActiveRestoreId(result.restore?.id)

            // Poll for completion
            const final = await pollForCompletion(
                () => svc.getRestoreOperation(result.restore.id),
                (status) => setRestoreOperation(status),
                1000,
                300000 // 5 min timeout
            )

            setRestoreOperation(final)
            setStep(3) // Go to results step

            if (!dryRun && final.status === 'completed') {
                onComplete()
            }

        } catch (err) {
            console.error('Restore failed:', err)
            setError(err.message)
        } finally {
            setIsRestoring(false)
        }
    }

    const renderStepContent = () => {
        switch (step) {
            case 0: // Select Components
                return (
                    <div className="restore-step-content">
                        <h4>Select Components to Restore</h4>
                        <p>Choose which components to restore from this backup. Leave empty to restore all.</p>

                        {comparisonLoading && (
                            <div className="restore-comparison" style={{ opacity: 0.6 }}>
                                <h5>Loading comparison...</h5>
                            </div>
                        )}

                        {comparison && (
                            <div className="restore-comparison">
                                <h5>Backup vs Current Instance</h5>
                                <div className="restore-comparison-table">
                                    <div className="restore-comparison-row restore-comparison-header-row">
                                        <span>Component</span>
                                        <span>Backup</span>
                                        <span>Current</span>
                                        <span>Impact</span>
                                    </div>
                                    {[
                                        { label: 'Users', source: comparison.source?.users, current: comparison.current?.users },
                                        { label: 'Memories', source: comparison.source?.memories, current: comparison.current?.memories },
                                        { label: 'Objectives', source: comparison.source?.objectives, current: comparison.current?.objectives },
                                        { label: 'Tasks', source: comparison.source?.tasks, current: comparison.current?.tasks },
                                        { label: 'Envelopes', source: comparison.source?.envelopes, current: comparison.current?.envelopes },
                                    ].map(row => (
                                        <div key={row.label} className="restore-comparison-row">
                                            <span className="restore-comparison-label">{row.label}</span>
                                            <span className="restore-comparison-value">{row.source ?? '\u2014'}</span>
                                            <span className="restore-comparison-value">{row.current ?? '\u2014'}</span>
                                            <span className={`restore-comparison-impact ${
                                                row.source == null ? '' :
                                                row.source > row.current ? 'gain' :
                                                row.source < row.current ? 'loss' : 'same'
                                            }`}>
                                                {row.source == null ? '\u2014' :
                                                 row.source > row.current ? `+${row.source - row.current}` :
                                                 row.source < row.current ? `${row.source - row.current}` : '='}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                                <div className="restore-comparison-meta">
                                    <span>Source: {comparison.backup?.source_instance}</span>
                                    <span>Created: {new Date(comparison.backup?.created_at).toLocaleString()}</span>
                                </div>
                            </div>
                        )}

                        <div className="restore-components">
                            <div className="restore-components-actions">
                                <button
                                    className="restore-select-btn"
                                    onClick={() => setSelectedComponents(backupComponents.map(c => c.component_key))}
                                >
                                    Select All
                                </button>
                                <button
                                    className="restore-select-btn"
                                    onClick={() => setSelectedComponents([])}
                                >
                                    Select None
                                </button>
                                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginLeft: 'auto' }}>
                                    {selectedComponents.length} of {backupComponents.length} selected
                                </span>
                            </div>
                            {backupComponents.map(comp => (
                                <label key={comp.component_key} className="restore-component-option">
                                    <input
                                        type="checkbox"
                                        checked={selectedComponents.includes(comp.component_key)}
                                        onChange={() => handleComponentToggle(comp.component_key)}
                                    />
                                    <span className="component-info">
                                        <strong>{comp.name}</strong>
                                        <small>{comp.description}</small>
                                    </span>
                                </label>
                            ))}
                        </div>

                        <div className="restore-step-actions">
                            <button onClick={onClose}>Cancel</button>
                            <button className="primary" onClick={() => setStep(1)}>Next</button>
                        </div>
                    </div>
                )

            case 1: // Review
                return (
                    <div className="restore-step-content">
                        <h4>Review Restore Operation</h4>

                        <div className="restore-review">
                            <div className="review-item">
                                <span className="review-label">Backup</span>
                                <span className="review-value">{backup.name}</span>
                            </div>
                            <div className="review-item">
                                <span className="review-label">Created</span>
                                <span className="review-value">{new Date(backup.created_at).toLocaleString()}</span>
                            </div>
                            <div className="review-item">
                                <span className="review-label">Size</span>
                                <span className="review-value">{formatBytes(backup.archive_size_bytes || 0)}</span>
                            </div>
                            <div className="review-item">
                                <span className="review-label">Components</span>
                                <span className="review-value">
                                    {selectedComponents.length > 0
                                        ? `${selectedComponents.length} selected`
                                        : 'All components'}
                                </span>
                            </div>
                        </div>

                        <div className="restore-dry-run-option">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={dryRun}
                                    onChange={(e) => setDryRun(e.target.checked)}
                                />
                                <span>
                                    <strong>Dry Run (Recommended)</strong>
                                    <small>Simulate the restore without making changes</small>
                                </span>
                            </label>
                        </div>

                        <div className="restore-step-actions">
                            <button onClick={() => setStep(0)}>Back</button>
                            <button className="primary" onClick={() => setStep(2)}>Next</button>
                        </div>
                    </div>
                )

            case 2: // Confirm
                return (
                    <div className="restore-step-content">
                        <h4>{dryRun ? 'Start Dry Run?' : 'Confirm Restore'}</h4>

                        {dryRun ? (
                            <div className="restore-warning info">
<span style={{ fontSize: 20, lineHeight: 1 }}>ℹ</span>
                                <div>
                                    <strong>Dry Run Mode</strong>
                                    <p>This will simulate the restore and show what would be changed, without actually modifying any data.</p>
                                </div>
                            </div>
                        ) : (
                            <div className="restore-warning danger">
<span style={{ fontSize: 20, lineHeight: 1 }}>⚠</span>
                                <div>
                                    <strong>Warning: This will overwrite existing data</strong>
                                    <p>Restoring will replace current data with the backup version. This action cannot be undone. Make sure you have a recent backup of your current state.</p>
                                </div>
                            </div>
                        )}

                        {error && (
                            <div className="restore-error">
                                <strong>Error:</strong> {error}
                            </div>
                        )}

                        {activeRestoreId && isRestoring && (
                            <RestoreProgress restoreId={activeRestoreId} />
                        )}

                        <div className="restore-step-actions">
                            <button onClick={() => setStep(1)} disabled={isRestoring}>Back</button>
                            <button
                                className={dryRun ? 'primary' : 'danger'}
                                onClick={handleRestore}
                                disabled={isRestoring}
                            >
                                {isRestoring ? (
                                    <>
                                        <span className="backup-spinner"></span>
                                        {dryRun ? 'Running Simulation...' : 'Restoring...'}
                                    </>
                                ) : (
                                    dryRun ? 'Start Dry Run' : 'Restore Now'
                                )}
                            </button>
                        </div>
                    </div>
                )

            case 3: // Results
                return (
                    <div className="restore-step-content">
                        <h4>
                            {restoreOperation?.dry_run
                                ? 'Dry Run Complete'
                                : restoreOperation?.status === 'completed'
                                    ? 'Restore Complete'
                                    : 'Restore Failed'}
                        </h4>

                        {restoreOperation && (
                            <div className="restore-results">
                                <div className={`restore-status ${restoreOperation.status}`}>
                                    {restoreOperation.status === 'dry_run_complete' && (
                                        <>
                                            <span style={{ fontSize: 48, lineHeight: 1, color: 'rgba(34, 197, 94, 0.9)' }}>✓</span>
                                            <p>Simulation complete. No changes were made.</p>
                                        </>
                                    )}
                                    {restoreOperation.status === 'completed' && (
                                        <>
                                            <span style={{ fontSize: 48, lineHeight: 1, color: 'rgba(34, 197, 94, 0.9)' }}>✓</span>
                                            <p>Restore completed successfully!</p>
                                        </>
                                    )}
                                    {restoreOperation.status === 'failed' && (
                                        <>
                                            <span style={{ fontSize: 48, lineHeight: 1, color: 'rgba(239, 68, 68, 0.9)' }}>✕</span>
                                            <p>Restore failed: {restoreOperation.error_message}</p>
                                        </>
                                    )}
                                </div>

                                {restoreOperation.files_restored > 0 && (
                                    <div className="restore-stats">
                                        <div className="restore-stat">
                                            <strong>{restoreOperation.files_restored}</strong>
                                            <span>Files Restored</span>
                                        </div>
                                        <div className="restore-stat">
                                            <strong>{formatBytes(restoreOperation.bytes_restored || 0)}</strong>
                                            <span>Data Restored</span>
                                        </div>
                                    </div>
                                )}

                                {restoreOperation.preview && (
                                    <div className="restore-preview">
                                        <h5>Preview Summary</h5>
                                        <pre>{JSON.stringify(restoreOperation.preview, null, 2)}</pre>
                                    </div>
                                )}

                                {restoreOperation.warnings && restoreOperation.warnings.length > 0 && (
                                    <div className="restore-warnings">
                                        <h5>Warnings</h5>
                                        <ul>
                                            {restoreOperation.warnings.map((w, i) => (
                                                <li key={i}>{w.message}</li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        )}

                        {rollbackResult && (
                            <div className="restore-warning info">
                                <span style={{ fontSize: 20, lineHeight: 1 }}>↩</span>
                                <div>
                                    <strong>Rollback Complete</strong>
                                    <p>{rollbackResult.message}</p>
                                </div>
                            </div>
                        )}

                        <div className="restore-step-actions">
                            {restoreOperation?.dry_run && restoreOperation?.status === 'dry_run_complete' && (
                                <button
                                    className="danger"
                                    onClick={() => {
                                        setDryRun(false)
                                        setRestoreOperation(null)
                                        setStep(2)
                                    }}
                                >
                                    Proceed with Actual Restore
                                </button>
                            )}
                            {!restoreOperation?.dry_run && (restoreOperation?.status === 'completed' || restoreOperation?.status === 'completed_with_errors') && !rollbackResult && (
                                <button
                                    className="restore-rollback-btn"
                                    onClick={async () => {
                                        if (!window.confirm('Undo this restore? This will revert all restored files to their pre-restore state.')) return
                                        setIsRollingBack(true)
                                        try {
                                            const svc = createBackupService(authFetch, currentOrg?.id)
                                            const result = await svc.rollbackRestore(activeRestoreId || restoreOperation.id)
                                            setRollbackResult(result)
                                        } catch (err) {
                                            setError('Rollback failed: ' + err.message)
                                        } finally {
                                            setIsRollingBack(false)
                                        }
                                    }}
                                    disabled={isRollingBack}
                                >
                                    {isRollingBack ? (
                                        <><span className="backup-spinner" style={{ width: 12, height: 12 }} /> Rolling back...</>
                                    ) : (
                                        '↩ Undo Restore'
                                    )}
                                </button>
                            )}
                            <button className="primary" onClick={onClose}>Close</button>
                        </div>
                    </div>
                )

            default:
                return null
        }
    }

    return (
        <div className="restore-wizard-overlay" onClick={onClose}>
            <div className="restore-wizard" onClick={e => e.stopPropagation()}>
                <div className="restore-wizard-header">
                    <h3>Restore from Backup</h3>
                    <button className="close-btn" onClick={onClose}>
                        <span style={{ fontSize: 18, lineHeight: 1, color: 'rgba(255, 255, 255, 0.7)' }}>✕</span>
                    </button>
                </div>

                <StepIndicator currentStep={step} steps={STEPS} />

                {renderStepContent()}
            </div>
        </div>
    )
}

export default RestoreWizard
