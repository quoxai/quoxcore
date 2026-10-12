/**
 * OrgBudgetsPanel — STUDY-REV-2 P8.B.3
 *
 * Org-wide monthly budget configuration panel.
 * Displayed inside OrgDashboardLayout for admin users.
 *
 * Features:
 *   - Monthly USD cap + tokens cap inputs
 *   - Hard-stop toggle (blocks new runs at 100%)
 *   - Current usage stats (tokens, cost, days remaining, projection)
 *   - Creates budget if none exists for current period; updates if exists
 *
 * Props:
 *   orgId    {string}  — org entity ID
 *   isAdmin  {boolean} — shows form controls only for admins
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import {
    listBudgets,
    getUsage,
    createBudget,
    updateBudget,
} from '../../services/budgetClient'

// ── Period helpers ────────────────────────────────────────────────────────────

function currentPeriod() {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    return {
        start: start.toISOString(),
        end: end.toISOString(),
        daysTotal: (end - start) / 86400000,
        daysElapsed: (now - start) / 86400000,
        daysRemaining: Math.ceil((end - now) / 86400000),
    }
}

function microToUsd(micro) {
    return micro ? +(micro / 1e6).toFixed(2) : 0
}

function usdToMicro(usd) {
    return Math.round(parseFloat(usd || 0) * 1e6)
}

// ── Stat ring ─────────────────────────────────────────────────────────────────

function PercentRing({ pct, label, size = 56 }) {
    const clamp = Math.min(100, Math.max(0, pct))
    const variant = clamp >= 100 ? 'qx-percent--crit' : clamp >= 80 ? 'qx-percent--warn' : 'qx-percent--success'
    return (
        <div
            className={`qx-percent ${variant}`}
            style={{ '--qx-pct-fill': `${clamp}%`, '--qx-pct-size': `${size}px` }}
            aria-label={`${label}: ${clamp.toFixed(0)}%`}
        >
            <span className="qx-percent__value">{clamp.toFixed(0)}<i>%</i></span>
            <span className="qx-percent__label">{label}</span>
        </div>
    )
}

// ── OrgBudgetsPanel ────────────────────────────────────────────────────────────

export default function OrgBudgetsPanel({ orgId, isAdmin = false }) {
    const { authFetch } = useAuth()
    const period = currentPeriod()

    // Form state
    const [usdCap, setUsdCap] = useState('')
    const [tokensCap, setTokensCap] = useState('')
    const [hardStop, setHardStop] = useState(true)
    const [existingBudget, setExistingBudget] = useState(null)
    const [usage, setUsage] = useState(null)

    // UI state
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [toast, setToast] = useState(null)

    const showToast = useCallback((msg, variant = 'success') => {
        setToast({ msg, variant })
        setTimeout(() => setToast(null), 3000)
    }, [])

    // Load existing org-scope budget for the current period
    useEffect(() => {
        if (!orgId || !authFetch) return
        let cancelled = false

        setLoading(true)
        listBudgets({ authFetch, orgId, scope: 'org', scopeId: orgId })
            .then(async budgets => {
                if (cancelled) return
                // Find the budget for the current calendar month
                const now = Date.now()
                const current = Array.isArray(budgets)
                    ? budgets.find(b => {
                        const s = new Date(b.period_start).getTime()
                        const e = new Date(b.period_end).getTime()
                        return s <= now && now < e
                    })
                    : null

                if (current) {
                    setExistingBudget(current)
                    setUsdCap(String(microToUsd(current.max_cost_usd_micro)))
                    setTokensCap(String(current.max_tokens || ''))
                    setHardStop(current.hard_stop !== false)

                    // Fetch usage for this budget
                    const usageData = await getUsage({ authFetch, orgId, id: current.id }).catch(() => null)
                    if (!cancelled) setUsage(usageData)
                }
            })
            .catch(() => {})
            .finally(() => { if (!cancelled) setLoading(false) })

        return () => { cancelled = true }
    }, [orgId, authFetch])

    const handleSave = async (e) => {
        e.preventDefault()
        setSaving(true)
        try {
            const maxCostUsdMicro = usdToMicro(usdCap)
            const maxTokens = parseInt(tokensCap, 10) || undefined

            if (existingBudget) {
                await updateBudget({
                    authFetch,
                    orgId,
                    id: existingBudget.id,
                    maxCostUsdMicro,
                    maxTokens,
                    hardStop,
                })
            } else {
                await createBudget({
                    authFetch,
                    orgId,
                    scopeKind: 'org',
                    scopeId: orgId,
                    periodStart: period.start,
                    periodEnd: period.end,
                    maxCostUsdMicro,
                    maxTokens,
                    hardStop,
                })
            }
            showToast('Budget saved')
        } catch (err) {
            showToast(err?.message || 'Save failed', 'error')
        } finally {
            setSaving(false)
        }
    }

    // Derived usage stats
    // R3.high: engine returns camelCase totalTokens / totalCostUsdMicro
    // (quoxflow src/api/routes/budgets.ts:276-282).
    // Legacy fallback: sum tokens_in + tokens_out if old shape is returned.
    const usageTokens = (usage?.usage?.totalTokens != null
        ? usage.usage.totalTokens
        : (usage?.usage?.tokens_in || 0) + (usage?.usage?.tokens_out || 0))
    const usageCostMicro = (usage?.usage?.totalCostUsdMicro != null
        ? usage.usage.totalCostUsdMicro
        : usage?.usage?.cost_usd_micro || 0)
    const capTokens = parseInt(tokensCap, 10) || 0
    const capCostMicro = usdToMicro(usdCap) || 0

    const tokenPct = capTokens > 0 ? (usageTokens / capTokens) * 100 : 0
    const costPct = capCostMicro > 0 ? (usageCostMicro / capCostMicro) * 100 : 0

    // Linear projection: cost/day so far → project to end of month
    const daysElapsed = Math.max(1, period.daysElapsed)
    const dailyRate = usageCostMicro / daysElapsed
    const projectedCostMicro = dailyRate * period.daysTotal

    return (
        <div className="qx-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Header */}
            <div>
                <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700, color: 'var(--m-text-primary)' }}>
                    Monthly budget
                </h2>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--m-text-tertiary)' }}>
                    Caps spending across all workflows and objectives in this org.
                    Resets on the 1st of each month.
                </p>
            </div>

            {/* Form */}
            {isAdmin && (
                <form onSubmit={handleSave} className="qx-form" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div className="qx-field">
                        <label htmlFor="org-usd-cap" style={{ fontSize: 13, color: 'var(--m-text-tertiary)', display: 'block', marginBottom: 4 }}>
                            Monthly USD cap
                        </label>
                        <input
                            id="org-usd-cap"
                            type="number"
                            className="qx-input"
                            value={usdCap}
                            onChange={e => setUsdCap(e.target.value)}
                            min={0}
                            step={1}
                            placeholder="e.g. 100"
                            style={{ maxWidth: 200 }}
                        />
                    </div>

                    <div className="qx-field">
                        <label htmlFor="org-tokens-cap" style={{ fontSize: 13, color: 'var(--m-text-tertiary)', display: 'block', marginBottom: 4 }}>
                            Monthly tokens cap
                        </label>
                        <input
                            id="org-tokens-cap"
                            type="number"
                            className="qx-input"
                            value={tokensCap}
                            onChange={e => setTokensCap(e.target.value)}
                            min={0}
                            step={10000}
                            placeholder="e.g. 2000000"
                            style={{ maxWidth: 200 }}
                        />
                    </div>

                    <div className="qx-field">
                        <label className="qx-toggle" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={hardStop}
                                onChange={e => setHardStop(e.target.checked)}
                                aria-label="Hard stop on exceed"
                            />
                            <span className="qx-toggle__track" />
                            <span style={{ fontSize: 13, color: 'var(--m-text-primary)' }}>
                                Hard stop on exceed
                            </span>
                        </label>
                        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--m-text-tertiary)' }}>
                            When on, new workflow runs are blocked once the cap is reached.
                        </p>
                    </div>

                    <div>
                        <button
                            type="submit"
                            className="qx-btn qx-btn--primary"
                            disabled={saving || loading}
                        >
                            {saving ? 'Saving…' : 'Save budget'}
                        </button>
                    </div>
                </form>
            )}

            {/* Current usage stats */}
            {existingBudget && (
                <div>
                    <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: 'var(--m-text-primary)' }}>
                        Current usage
                    </h3>

                    {/* Percent rings */}
                    {(capTokens > 0 || capCostMicro > 0) && (
                        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16 }}>
                            {capCostMicro > 0 && <PercentRing pct={costPct} label="Cost" />}
                            {capTokens > 0 && <PercentRing pct={tokenPct} label="Tokens" />}
                        </div>
                    )}

                    {/* Stat rows */}
                    <div className="qx-card qx-card--compact" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                        <div className="qx-stat-row">
                            <span className="qx-stat-row__label">Tokens used</span>
                            <span className="qx-stat-row__value">
                                {usageTokens.toLocaleString()}{capTokens > 0 ? ` / ${capTokens.toLocaleString()}` : ''}
                            </span>
                        </div>
                        <div className="qx-stat-row">
                            <span className="qx-stat-row__label">Cost spent</span>
                            <span className="qx-stat-row__value">
                                ${microToUsd(usageCostMicro).toFixed(4)}{capCostMicro > 0 ? ` / $${microToUsd(capCostMicro).toFixed(2)}` : ''}
                            </span>
                        </div>
                        <div className="qx-stat-row">
                            <span className="qx-stat-row__label">Days remaining</span>
                            <span className="qx-stat-row__value">{period.daysRemaining}</span>
                        </div>
                        {usageCostMicro > 0 && period.daysElapsed >= 1 && (
                            <div className="qx-stat-row">
                                <span className="qx-stat-row__label">Projected end-of-month</span>
                                <span className="qx-stat-row__value">
                                    ${microToUsd(projectedCostMicro).toFixed(2)}
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Toast feedback */}
            {toast && (
                <div
                    className={`qx-toast qx-toast--${toast.variant}`}
                    role="status"
                    aria-live="polite"
                >
                    {toast.msg}
                </div>
            )}
        </div>
    )
}
