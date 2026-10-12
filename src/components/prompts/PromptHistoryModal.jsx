/**
 * PromptHistoryModal — STUDY-REV-2 / P7.E.2
 *
 * Version history for a prompt.
 * Receives `versions` as a prop (from GET /api/prompts/:id/versions).
 * Restore triggers POST /api/prompts/:id/restore/:version via onRestore(version).
 *
 * No localStorage reads — all data comes from the server.
 */

import { useState } from 'react'

function PromptHistoryModal({ promptId, versions = [], onRestore, onClose }) {
    const [selectedIdx, setSelectedIdx] = useState(null)

    const formatDate = (iso) => {
        if (!iso) return '—'
        const d = new Date(iso)
        return d.toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        })
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                className="modal-content"
                onClick={(e) => e.stopPropagation()}
                style={{ maxWidth: 700, width: '90vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
            >
                {/* Header */}
                <div className="modal-header">
                    <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 14" />
                        </svg>
                        Version History
                    </h2>
                    <button className="modal-close" onClick={onClose}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                {/* Body */}
                <div style={{ flex: 1, overflow: 'auto', padding: '0 20px 20px' }}>
                    {versions.length === 0 ? (
                        <div style={{
                            textAlign: 'center',
                            padding: '40px 20px',
                            color: 'var(--text-secondary, #94a3b8)',
                        }}>
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                                style={{ opacity: 0.4, marginBottom: 12 }}>
                                <circle cx="12" cy="12" r="10" />
                                <polyline points="12 6 12 12 16 14" />
                            </svg>
                            <p style={{ margin: 0, fontSize: 14 }}>No previous versions yet.</p>
                            <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.7 }}>
                                Versions are saved each time you edit this prompt.
                            </p>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', gap: 16, minHeight: 300 }}>
                            {/* Version list */}
                            <div style={{
                                width: 240,
                                flexShrink: 0,
                                borderRight: '1px solid var(--border-color, rgba(148, 163, 184, 0.15))',
                                paddingRight: 16,
                            }}>
                                <div style={{ fontSize: 11, color: 'var(--text-secondary, #94a3b8)', marginBottom: 8, fontWeight: 500 }}>
                                    {versions.length} version{versions.length !== 1 ? 's' : ''}
                                </div>
                                {versions.map((v, idx) => (
                                    <button
                                        key={v.version ?? idx}
                                        onClick={() => setSelectedIdx(idx === selectedIdx ? null : idx)}
                                        style={{
                                            display: 'block',
                                            width: '100%',
                                            textAlign: 'left',
                                            padding: '10px 12px',
                                            marginBottom: 4,
                                            borderRadius: 6,
                                            border: idx === selectedIdx
                                                ? '1px solid rgba(139, 92, 246, 0.5)'
                                                : '1px solid transparent',
                                            background: idx === selectedIdx
                                                ? 'rgba(139, 92, 246, 0.1)'
                                                : 'transparent',
                                            cursor: 'pointer',
                                            color: 'inherit',
                                        }}
                                    >
                                        <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 2 }}>
                                            v{v.version} — {v.name || 'Untitled'}
                                        </div>
                                        <div style={{ fontSize: 11, color: 'var(--text-secondary, #94a3b8)' }}>
                                            {formatDate(v.created_at)}
                                        </div>
                                        <div style={{
                                            fontSize: 11,
                                            color: 'var(--text-secondary, #94a3b8)',
                                            opacity: 0.7,
                                            marginTop: 4,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}>
                                            {v.body?.slice(0, 60) || '(empty)'}
                                        </div>
                                    </button>
                                ))}
                            </div>

                            {/* Detail pane */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                                {selectedIdx === null ? (
                                    <div style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        height: '100%',
                                        color: 'var(--text-secondary, #94a3b8)',
                                        fontSize: 13,
                                    }}>
                                        Select a version to preview
                                    </div>
                                ) : (
                                    <>
                                        <div style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            marginBottom: 12,
                                        }}>
                                            <span style={{ fontSize: 12, color: 'var(--text-secondary, #94a3b8)' }}>
                                                v{versions[selectedIdx]?.version} — {formatDate(versions[selectedIdx]?.created_at)}
                                            </span>
                                            <button
                                                className="btn btn-primary"
                                                style={{ fontSize: 12, padding: '6px 14px' }}
                                                onClick={() => {
                                                    if (confirm('Restore this version? The current content will be saved as a new version.')) {
                                                        onRestore(versions[selectedIdx])
                                                    }
                                                }}
                                            >
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 4 }}>
                                                    <polyline points="1 4 1 10 7 10" />
                                                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                                                </svg>
                                                Restore
                                            </button>
                                        </div>
                                        <pre style={{
                                            fontFamily: 'monospace',
                                            fontSize: 12,
                                            lineHeight: 1.6,
                                            background: 'rgba(0, 0, 0, 0.3)',
                                            borderRadius: 6,
                                            border: '1px solid var(--border-color, rgba(148, 163, 184, 0.15))',
                                            padding: 12,
                                            maxHeight: 350,
                                            overflow: 'auto',
                                            whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-word',
                                            margin: 0,
                                            color: 'var(--text-primary, #e2e8f0)',
                                        }}>
                                            {versions[selectedIdx]?.body || '(empty)'}
                                        </pre>
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

export default PromptHistoryModal
