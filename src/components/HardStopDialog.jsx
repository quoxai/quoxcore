/**
 * HardStopDialog — STUDY-REV-2 P8.B.3
 *
 * Modal shown before firing a workflow run when the projected usage
 * would exceed a budget with hard_stop=true.
 *
 * Props:
 *   open        {boolean}   — controls visibility
 *   onClose     {Function}  — called on Cancel
 *   scope       {string}    — budget scope label (e.g. 'org', 'workflow-xyz')
 *   current     {object}    — current usage snapshot { cost_usd_micro, tokens, ... }
 *   projected   {object}    — projected usage at end of run
 *   exceeded    {string[]}  — dimension labels that would be exceeded
 *   onOverride  {Function}  — if provided AND user is admin, renders Override button
 */

import { useEffect, useRef } from 'react'
import { useWorkspace } from '../contexts/WorkspaceContext'

function formatMicro(micro) {
    return `$${(micro / 1e6).toFixed(4)}`
}

function formatTokens(n) {
    if (!n) return '0'
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function formatDimension(dim, val) {
    if (dim === 'cost' || dim === 'cost_usd_micro') return formatMicro(val || 0)
    if (dim === 'tokens' || dim === 'tokens_in' || dim === 'tokens_out') return formatTokens(val || 0)
    return String(val ?? '—')
}

export default function HardStopDialog({
    open,
    onClose,
    scope,
    current = {},
    projected = {},
    exceeded = [],
    onOverride,
}) {
    // Org role lives on the workspace membership, not the auth user object:
    // `user.role` does not exist, so this was false for everyone and the
    // admin override never rendered (2026-08-20, same fix as SlotsDeckPanel).
    const { currentOrg } = useWorkspace()
    const role = currentOrg?.membership?.role
    const isAdmin = role === 'admin' || role === 'owner'
    const cancelRef = useRef(null)

    // Default focus on Cancel button when dialog opens
    useEffect(() => {
        if (open) {
            setTimeout(() => cancelRef.current?.focus(), 50)
        }
    }, [open])

    // Close on Escape
    useEffect(() => {
        if (!open) return
        const handler = (e) => { if (e.key === 'Escape') onClose?.() }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [open, onClose])

    if (!open) return null

    return (
        <div
            className="qx-modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hsd-title"
            onClick={e => { if (e.target === e.currentTarget) onClose?.() }}
        >
            <div className="qx-modal" style={{ maxWidth: 480, width: '100%' }}>
                {/* Title */}
                <h2
                    id="hsd-title"
                    style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700, color: 'var(--m-text-primary)' }}
                >
                    Budget would be exceeded
                </h2>

                {/* Danger banner */}
                <div className="qx-banner qx-banner--danger" role="alert" style={{ marginBottom: 16 }}>
                    Running this workflow would exceed the <strong>{scope}</strong> budget
                    {exceeded.length > 0 && ` — ${exceeded.join(', ')}`}.
                    New runs are blocked by hard stop.
                </div>

                {/* Stat rows — current → projected per exceeded dimension */}
                {exceeded.length > 0 && (
                    <div className="qx-card qx-card--compact" style={{ marginBottom: 20 }}>
                        {exceeded.map(dim => {
                            const cur = current[dim] ?? current[`${dim}_usd_micro`] ?? current.cost_usd_micro
                            const proj = projected[dim] ?? projected[`${dim}_usd_micro`] ?? projected.cost_usd_micro
                            return (
                                <div key={dim} className="qx-stat-row">
                                    <span className="qx-stat-row__label" style={{ textTransform: 'capitalize' }}>{dim}</span>
                                    <span className="qx-stat-row__value" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                                        {formatDimension(dim, cur)}
                                        <span style={{ color: 'var(--m-text-tertiary)', margin: '0 6px' }}>→</span>
                                        <span style={{ color: 'var(--m-danger, #f87171)' }}>
                                            {formatDimension(dim, proj)}
                                        </span>
                                    </span>
                                </div>
                            )
                        })}
                    </div>
                )}

                {/* Actions */}
                <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                    <button
                        ref={cancelRef}
                        type="button"
                        className="qx-btn"
                        onClick={onClose}
                    >
                        Cancel
                    </button>
                    {isAdmin && onOverride && (
                        <button
                            type="button"
                            className="qx-btn qx-btn--danger"
                            onClick={onOverride}
                        >
                            Override &amp; run
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}
