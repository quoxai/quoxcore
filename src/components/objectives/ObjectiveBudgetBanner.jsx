/**
 * ObjectiveBudgetBanner — STUDY-REV-2 P8.B.3
 *
 * Renders a warning or danger banner on an objective card when any budget
 * dimension reaches 80% (warning) or 100% (danger/hard-stop).
 *
 * Props:
 *   authFetch  {Function}  — authenticated fetch from useAuth
 *   budget     {object}    — budget record with id + max_* fields
 *
 * The component fetches usage on mount and re-evaluates when the budget prop
 * changes (objective re-render cycle).
 */

import { useState, useEffect } from 'react'

const MICRO = 1e6

// Dimensions to check: [key in usage, max field in budget, display label]
// R3.high: engine returns camelCase fields: totalTokens, totalCostUsdMicro, etc.
// (see quoxflow src/api/routes/budgets.ts:276-282)
const DIMS = [
    ['totalTokens', 'max_tokens', 'tokens'],
    ['totalCostUsdMicro', 'max_cost_usd_micro', 'cost'],
    ['totalToolCalls', 'max_tool_calls', 'tool calls'],
    ['totalDurationMs', 'max_duration_ms', 'duration'],
]

function computeDimensions(usage, budget) {
    const results = []

    for (const [key, maxKey, label] of DIMS) {
        const max = budget[maxKey]
        if (!max) continue // dimension not configured

        const current = usage[key] || 0

        const pct = Math.round((current / max) * 100)
        if (pct >= 80) {
            results.push({ label, pct, exceeded: pct >= 100 })
        }
    }

    return results
}

export default function ObjectiveBudgetBanner({ authFetch, budget }) {
    const [dims, setDims] = useState([])
    const [loaded, setLoaded] = useState(false)

    useEffect(() => {
        if (!budget?.id || !authFetch) return

        let cancelled = false
        import('../../services/budgetClient').then(({ getUsage }) => {
            getUsage({ authFetch, id: budget.id })
                .then(data => {
                    if (cancelled) return
                    const usage = data?.usage || data || {}
                    setDims(computeDimensions(usage, budget))
                    setLoaded(true)
                })
                .catch(() => {
                    if (!cancelled) setLoaded(true)
                })
        })

        return () => { cancelled = true }
    }, [authFetch, budget?.id])

    if (!loaded || dims.length === 0) return null

    const exceeded = dims.filter(d => d.exceeded)
    const warnings = dims.filter(d => !d.exceeded)
    const hardStop = budget.hard_stop !== false

    if (exceeded.length > 0 && hardStop) {
        return (
            <div className="qx-banner qx-banner--danger" role="alert">
                <span>
                    Budget exhausted — execution blocked.{' '}
                    {exceeded.map(d => `${d.label} (${d.pct}%)`).join(', ')}.{' '}
                    Adjust at <a href="/settings#budgets">Budgets</a>
                </span>
            </div>
        )
    }

    if (warnings.length > 0) {
        const first = warnings[0]
        return (
            <div className="qx-banner qx-banner--warning" role="status">
                <span>
                    Budget at {first.pct}% — {first.label}
                    {warnings.length > 1 && ` (+${warnings.length - 1} more)`}
                </span>
            </div>
        )
    }

    return null
}
