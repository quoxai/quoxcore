/**
 * AgentsSummaryCard — Agent roster summary for DashboardView
 *
 * Shows 3-stat grid (total, active, idle) + tool-grant truth status.
 * "Active" = agents with >=1 tool granted per loadAgentToolsTruth() (runtime
 * collector truth, falls back to the declared registry list if the collector
 * is unreachable). Recent-delegation count was considered but omitted:
 * delegationAudit.js only fires write-only AEE envelopes, it exposes no
 * read/count function, so a "delegations (24h)" stat would be fabricated.
 * When the roster/tool data is not available, shows a disabled state.
 */

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getAllAgents } from '../../config/agentRegistry'
import { loadAgentToolsTruth } from '../../services/agentToolsTruth'
import './agents-summary.css'

function AgentsSummaryCard() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const agents = getAllAgents()
        const total = agents.length
        const { agentTools, source } = await loadAgentToolsTruth()
        const active = agents.filter((a) => (agentTools[a.id] || []).length > 0).length
        if (!cancelled) {
          setData({ total, active, idle: Math.max(total - active, 0), source })
        }
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
  }, [])

  if (error) {
    return (
      <div className="dashboard-card agents-summary-card agents-summary-card--disabled">
        <div className="dashboard-card__header">
          <div className="dashboard-card__title">
            <AgentsIcon />
            <span>Agents</span>
          </div>
        </div>
        <div className="dashboard-card__body">
          <p className="agents-summary-card__disabled-text">
            Agent roster data is not available right now. Agent counts and tool-grant status will appear here once the registry and collector are reachable.
          </p>
        </div>
      </div>
    )
  }

  const s = data || {}
  const isLive = s.source === 'runtime'

  return (
    <div className="dashboard-card agents-summary-card">
      <div className="agents-summary-card__accent" />
      <div className="dashboard-card__header">
        <div className="dashboard-card__title">
          <AgentsIcon />
          <span>Agents</span>
        </div>
        <Link to="/agents" className="dashboard-card__link">View agents</Link>
      </div>
      <div className="dashboard-card__body">
        <div className="agents-summary-card__stats">
          <div className="agents-summary-card__stat">
            <span className="agents-summary-card__stat-value">{s.total || 0}</span>
            <span className="agents-summary-card__stat-label">total</span>
          </div>
          <div className="agents-summary-card__stat">
            <span className="agents-summary-card__stat-value">{s.active || 0}</span>
            <span className="agents-summary-card__stat-label">active</span>
          </div>
          <div className="agents-summary-card__stat">
            <span className="agents-summary-card__stat-value">{s.idle || 0}</span>
            <span className="agents-summary-card__stat-label">idle</span>
          </div>
        </div>
        <div className="agents-summary-card__meta">
          <div className="agents-summary-card__meta-row">
            <span className={`status-dot ${isLive ? 'status-dot--online' : 'status-dot--offline'}`}></span>
            <span>Tool grants: {isLive ? 'Live' : 'Unverified fallback'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

const AgentsIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="6" cy="7" r="2.5" />
    <circle cx="18" cy="7" r="2.5" />
    <circle cx="12" cy="17" r="2.5" />
    <path d="M8 8.8L10.5 15M16 8.8L13.5 15M8.4 7H15.6" />
  </svg>
)

export default AgentsSummaryCard
