/**
 * CostSummaryCard — Org budget/spend summary for DashboardView
 *
 * Shows spend-this-period, cap, % used, and tokens-used stats sourced from
 * the real budgetClient (listBudgets + getUsage), the same client and field
 * shapes OrgBudgetsPanel.jsx uses (services/budgetClient.js, quoxflow budgets
 * API). Never fabricates numbers: if no org-scope budget exists for the
 * current period, or the fetch errors, shows a disabled/empty state instead
 * of zeros dressed as real data.
 */

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { listBudgets, getUsage } from '../../services/budgetClient'
import './cost-summary.css'

function microToUsd(micro) {
  return micro ? +(micro / 1e6).toFixed(2) : 0
}

function findCurrentPeriodBudget(budgets) {
  if (!Array.isArray(budgets)) return null
  const now = Date.now()
  return budgets.find((b) => {
    const s = new Date(b.period_start).getTime()
    const e = new Date(b.period_end).getTime()
    return s <= now && now < e
  }) || null
}

function CostSummaryCard() {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  const [noBudget, setNoBudget] = useState(false)

  const orgId = currentOrg?.id

  useEffect(() => {
    if (!authFetch || !orgId) {
      setError(true)
      return
    }
    let cancelled = false

    const load = async () => {
      try {
        const budgets = await listBudgets({ authFetch, orgId, scope: 'org', scopeId: orgId })
        const budget = findCurrentPeriodBudget(budgets)
        if (!budget) {
          if (!cancelled) {
            setNoBudget(true)
            setData(null)
          }
          return
        }

        const usage = await getUsage({ authFetch, orgId, id: budget.id }).catch(() => null)
        if (cancelled) return

        const usageTokens = usage?.usage?.totalTokens != null
          ? usage.usage.totalTokens
          : (usage?.usage?.tokens_in || 0) + (usage?.usage?.tokens_out || 0)
        const usageCostMicro = usage?.usage?.totalCostUsdMicro != null
          ? usage.usage.totalCostUsdMicro
          : usage?.usage?.cost_usd_micro || 0

        const capCostMicro = budget.max_cost_usd_micro || 0
        const capTokens = budget.max_tokens || 0
        const costPct = capCostMicro > 0 ? Math.round((usageCostMicro / capCostMicro) * 100) : null

        const periodEnd = new Date(budget.period_end)
        const daysRemaining = Math.max(0, Math.ceil((periodEnd - Date.now()) / 86400000))

        setNoBudget(false)
        setData({
          spendUsd: microToUsd(usageCostMicro),
          capUsd: capCostMicro > 0 ? microToUsd(capCostMicro) : null,
          costPct,
          tokensUsed: usageTokens,
          capTokens: capTokens > 0 ? capTokens : null,
          hardStop: budget.hard_stop !== false,
          daysRemaining,
        })
      } catch {
        if (!cancelled) setError(true)
      }
    }

    load()
    const interval = setInterval(load, 30000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [authFetch, orgId])

  const budgetsLinkTarget = orgId ? `/orgs/${orgId}` : '/settings'

  if (error) {
    return (
      <div className="dashboard-card cost-summary-card cost-summary-card--disabled">
        <div className="dashboard-card__header">
          <div className="dashboard-card__title">
            <CostIcon />
            <span>Cost &amp; Spend</span>
          </div>
        </div>
        <div className="dashboard-card__body">
          <p className="cost-summary-card__disabled-text">
            Budget data is not available right now. Spend and cap stats will appear here once the budgets service is reachable.
          </p>
        </div>
      </div>
    )
  }

  if (noBudget) {
    return (
      <div className="dashboard-card cost-summary-card cost-summary-card--disabled">
        <div className="dashboard-card__header">
          <div className="dashboard-card__title">
            <CostIcon />
            <span>Cost &amp; Spend</span>
          </div>
          <Link to={budgetsLinkTarget} className="dashboard-card__link">Budgets</Link>
        </div>
        <div className="dashboard-card__body">
          <p className="cost-summary-card__disabled-text">
            No budget configured for this org. Set a monthly cap to track spend and token usage here.
          </p>
        </div>
      </div>
    )
  }

  const s = data || {}

  return (
    <div className="dashboard-card cost-summary-card">
      <div className="cost-summary-card__accent" />
      <div className="dashboard-card__header">
        <div className="dashboard-card__title">
          <CostIcon />
          <span>Cost &amp; Spend</span>
        </div>
        <Link to={budgetsLinkTarget} className="dashboard-card__link">Budgets</Link>
      </div>
      <div className="dashboard-card__body">
        <div className="cost-summary-card__stats">
          <div className="cost-summary-card__stat">
            <span className="cost-summary-card__stat-value">
              ${s.spendUsd?.toFixed(2) ?? '0.00'}
            </span>
            <span className="cost-summary-card__stat-label">spend</span>
          </div>
          <div className="cost-summary-card__stat">
            <span className="cost-summary-card__stat-value">
              {s.capUsd != null ? `$${s.capUsd.toFixed(2)}` : '—'}
            </span>
            <span className="cost-summary-card__stat-label">cap</span>
          </div>
          <div className="cost-summary-card__stat">
            <span className={`cost-summary-card__stat-value ${s.costPct != null && s.costPct >= 80 ? 'cost-summary-card__stat-value--warn' : ''}`}>
              {s.costPct != null ? `${s.costPct}%` : '—'}
            </span>
            <span className="cost-summary-card__stat-label">used</span>
          </div>
          <div className="cost-summary-card__stat">
            <span className="cost-summary-card__stat-value">
              {s.tokensUsed != null ? s.tokensUsed.toLocaleString() : '0'}
            </span>
            <span className="cost-summary-card__stat-label">tokens</span>
          </div>
        </div>
        <div className="cost-summary-card__meta">
          <div className="cost-summary-card__meta-row">
            <span className={`status-dot ${s.hardStop ? 'status-dot--online' : 'status-dot--offline'}`}></span>
            <span>Hard stop: {s.hardStop ? 'On' : 'Off'}</span>
            <span className="cost-summary-card__counter">{s.daysRemaining} days remaining</span>
          </div>
        </div>
      </div>
    </div>
  )
}

const CostIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v10M9.5 9.5c0-1.4 1.1-2.5 2.5-2.5s2.5.9 2.5 2.1c0 1.4-1.2 1.9-2.5 2.4-1.3.5-2.5 1-2.5 2.4 0 1.2 1.1 2.1 2.5 2.1s2.5-1.1 2.5-2.5" />
  </svg>
)

export default CostSummaryCard
