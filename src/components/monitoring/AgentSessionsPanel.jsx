/**
 * AgentSessionsPanel — Universal AI agent session monitoring.
 *
 * Shows active AI sessions (Claude, GPT, Gemini, Ollama) across the fleet.
 * Data source: /agent/{hostId}/api/v1/agents/sessions
 */

import { useState, useEffect, useCallback, memo } from 'react'
import '../core/monitoring/monitoring.css'

const COLLECTOR_URL = `${window.location.origin}/collector`

const AGENT_TYPE_ICONS = {
  claude: { icon: '◆', color: '#d97706' },
  gpt: { icon: '●', color: '#10b981' },
  openai: { icon: '●', color: '#10b981' },
  gemini: { icon: '▲', color: '#38bdf8' },
  ollama: { icon: '○', color: '#a78bfa' },
  unknown: { icon: '◇', color: '#6b7280' },
}

const STATUS_STYLES = {
  running: { color: '#30ff90', label: 'Running' },
  waiting: { color: '#fbbf24', label: 'Waiting' },
  idle: { color: '#6b7280', label: 'Idle' },
  finished: { color: '#6b7280', label: 'Finished' },
  failed: { color: '#ff5555', label: 'Failed' },
  stopped: { color: '#ff5555', label: 'Stopped' },
}

function formatDuration(startTime) {
  if (!startTime) return 'N/A'
  const ms = Date.now() - new Date(startTime).getTime()
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins}m ${seconds % 60}s`
  const hours = Math.floor(mins / 60)
  return `${hours}h ${mins % 60}m`
}

const SessionCard = memo(function SessionCard({ session }) {
  const agentType = (session.agent_type || session.type || 'unknown').toLowerCase()
  const typeInfo = AGENT_TYPE_ICONS[agentType] || AGENT_TYPE_ICONS.unknown
  const statusInfo = STATUS_STYLES[session.status] || STATUS_STYLES.finished

  return (
    <div className="asp-session">
      <div className="asp-session__icon" style={{ color: typeInfo.color }}>{typeInfo.icon}</div>
      <div className="asp-session__info">
        <div className="asp-session__top">
          <span className="asp-session__name">{session.agent_name || session.name || agentType}</span>
          <span className="asp-session__status" style={{ color: statusInfo.color }}>
            {session.status === 'running' && <span className="asp-session__pulse" style={{ background: statusInfo.color }} />}
            {statusInfo.label}
          </span>
        </div>
        <div className="asp-session__meta">
          {session.host_id && <span className="asp-session__host">{session.host_id}</span>}
          {session.project && <span className="asp-session__project">{session.project}</span>}
          <span className="asp-session__duration">{formatDuration(session.started_at || session.start_time)}</span>
          {session.event_count != null && <span className="asp-session__events">{session.event_count} events</span>}
        </div>
      </div>
    </div>
  )
})

export default function AgentSessionsPanel({ agents }) {
  const [sessions, setSessions] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchSessions = useCallback(async () => {
    // Try to fetch sessions from the first connected agent
    const agentList = agents || []
    const connectedAgent = agentList.find(a => a.status?.connection === 'connected')

    if (!connectedAgent) {
      setLoading(false)
      setError(null)
      setSessions([])
      return
    }

    try {
      const agentUrl = `${window.location.origin}/agent/${connectedAgent.host_id}`
      const [sessRes, summRes] = await Promise.all([
        fetch(`${agentUrl}/api/v1/agents/sessions`).catch(() => null),
        fetch(`${agentUrl}/api/v1/agents/summary`).catch(() => null),
      ])

      if (sessRes?.ok) {
        const data = await sessRes.json()
        setSessions(data.sessions || [])
      }
      if (summRes?.ok) {
        const data = await summRes.json()
        setSummary(data)
      }
      setError(null)
    } catch (err) {
      setError('Failed to fetch sessions')
    } finally {
      setLoading(false)
    }
  }, [agents])

  useEffect(() => {
    fetchSessions()
    const interval = setInterval(fetchSessions, 10000)
    return () => clearInterval(interval)
  }, [fetchSessions])

  const activeSessions = sessions.filter(s => s.status === 'running' || s.status === 'waiting' || s.status === 'idle')
  const recentSessions = sessions
    .filter(s => s.status !== 'running' && s.status !== 'waiting' && s.status !== 'idle')
    .slice(0, 5)

  const hasAgents = (agents || []).length > 0

  return (
    <div className="asp-panel">
      <div className="asp-header">
        <div className="asp-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
          </svg>
          <span>Agent Sessions</span>
          {activeSessions.length > 0 && (
            <span className="asp-badge">{activeSessions.length} active</span>
          )}
        </div>
        {summary && (
          <div className="asp-summary-row">
            <span className="asp-summary-stat">{summary.total_sessions || 0} total</span>
            <span className="asp-summary-stat">{summary.active_sessions || 0} active</span>
          </div>
        )}
      </div>

      <div className="asp-body">
        {loading && (
          <div className="asp-loading">Loading sessions...</div>
        )}

        {!loading && !hasAgents && (
          <div className="asp-empty">
            <span className="asp-empty__icon">◇</span>
            <span>No agents connected. Deploy QuoxAgent to monitor AI sessions.</span>
          </div>
        )}

        {!loading && hasAgents && sessions.length === 0 && !error && (
          <div className="asp-empty">
            <span className="asp-empty__icon">◇</span>
            <span>No active AI sessions. QuoxAgent monitors Claude, GPT, Gemini, and Ollama sessions across the fleet.</span>
          </div>
        )}

        {!loading && error && (
          <div className="asp-empty">
            <span className="asp-empty__icon" style={{ color: '#ff5555' }}>!</span>
            <span>{error}</span>
          </div>
        )}

        {activeSessions.length > 0 && (
          <>
            <div className="asp-section-label">Active</div>
            {activeSessions.map(session => (
              <SessionCard key={session.id || session.session_id} session={session} />
            ))}
          </>
        )}

        {recentSessions.length > 0 && (
          <>
            <div className="asp-section-label">Recent</div>
            {recentSessions.map(session => (
              <SessionCard key={session.id || session.session_id} session={session} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
