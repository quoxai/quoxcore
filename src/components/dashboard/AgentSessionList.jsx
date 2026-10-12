/**
 * AgentSessionList — AI session timeline
 *
 * Shows every AI agent session across the fleet: agent name, status,
 * project, duration, cost, tool calls, files modified.
 *
 * CLI-3.5B2 (Stream CLI Phase 3.5)
 */

import './AgentSessionList.css'

function formatDuration(ms) {
  if (!ms || ms <= 0) return 'running'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60}m`
}

function SessionRow({ session }) {
  const isRunning = session.status === 'running' || session.status === 'idle'
  const statusClass = isRunning ? 'session--running' : `session--${session.status}`

  return (
    <div className={`session-row ${statusClass}`}>
      <span className="session-status-dot">
        {isRunning ? '●' : '○'}
      </span>
      <span className="session-agent">{session.agent_name}</span>
      <span className="session-project">{session.project}</span>
      <span className="session-duration">
        {isRunning ? formatDuration(Date.now() - new Date(session.started_at).getTime()) : formatDuration(session.duration_ms)}
      </span>
      {session.cost_usd > 0 && (
        <span className="session-cost">${session.cost_usd.toFixed(2)}</span>
      )}
      {session.tool_call_count > 0 && (
        <span className="session-tools">{session.tool_call_count} tools</span>
      )}
      {session.files_modified > 0 && (
        <span className="session-files">{session.files_modified} files</span>
      )}
    </div>
  )
}

export default function AgentSessionList({ sessions, loading }) {
  if (loading) {
    return (
      <div className="agent-sessions agent-sessions--loading">
        <span>Loading sessions...</span>
      </div>
    )
  }

  if (!sessions || sessions.length === 0) {
    return (
      <div className="agent-sessions agent-sessions--empty">
        <span>No active sessions</span>
      </div>
    )
  }

  return (
    <div className="agent-sessions">
      <div className="agent-sessions-header">
        <span className="agent-sessions-title">Agent Sessions</span>
        <span className="agent-sessions-count">{sessions.length}</span>
      </div>
      <div className="agent-sessions-list">
        {sessions.map(s => (
          <SessionRow key={s.id} session={s} />
        ))}
      </div>
    </div>
  )
}
