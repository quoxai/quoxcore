/**
 * AIRunningIndicator — Header badge showing all active AI processes.
 *
 * Tracks: active chats, running objectives, workflows, tool executions.
 * Health states: active (green), stale >10m (amber), stuck >30m (red).
 * Click-through to relevant detail views.
 */

import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRunningProcesses, formatElapsed } from '../../hooks/useRunningProcesses'

const TYPE_ICONS = {
  chat: '💬',
  objective: '🎯',
  workflow: '⚙️',
  tool: '⚡',
}

function AIRunningIndicator() {
  const navigate = useNavigate()
  const { processes, runningCount, staleCount, stuckCount, chatCount, objectiveCount, loading } = useRunningProcesses()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const badgeRef = useRef(null)
  const [now, setNow] = useState(Date.now())

  // Update elapsed times every 5s while dropdown is open
  useEffect(() => {
    if (!dropdownOpen) return
    const interval = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(interval)
  }, [dropdownOpen])

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return
    function handleClick(e) {
      if (badgeRef.current && !badgeRef.current.contains(e.target)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [dropdownOpen])

  // Determine badge state
  let dotClass = 'ai-running__dot--idle'
  let label = 'AI Idle'

  if (loading) {
    label = 'AI ...'
  } else if (stuckCount > 0) {
    dotClass = 'ai-running__dot--stuck'
    label = `${runningCount} AI`
  } else if (staleCount > 0) {
    dotClass = 'ai-running__dot--stale'
    label = `${runningCount} AI`
  } else if (runningCount > 0) {
    dotClass = 'ai-running__dot--active'
    label = `${runningCount} AI`
  }

  // Build subtitle showing what types are active
  let subtitle = ''
  if (runningCount > 0 && !loading) {
    const parts = []
    if (chatCount > 0) parts.push(`${chatCount} chat${chatCount !== 1 ? 's' : ''}`)
    if (objectiveCount > 0) parts.push(`${objectiveCount} obj`)
    subtitle = parts.join(', ')
  }

  const handleClickProcess = (proc) => {
    setDropdownOpen(false)
    if (proc.type === 'objective') {
      navigate(`/objectives/${proc.id}`)
    } else if (proc.type === 'chat') {
      // Chat processes don't have a dedicated page — just close dropdown
    }
  }

  return (
    <span
      className="app-shell__status-badge ai-running"
      ref={badgeRef}
      onClick={() => runningCount > 0 ? setDropdownOpen(!dropdownOpen) : navigate('/objectives')}
      style={{ cursor: 'pointer' }}
      title={runningCount > 0 ? `${runningCount} active AI processes (${subtitle})` : 'No active AI processes'}
    >
      <span className={`ai-running__dot ${dotClass}`} />
      {label}
      {runningCount > 0 && (
        <span style={{ fontSize: 10, opacity: 0.6, lineHeight: 1 }}>
          {dropdownOpen ? '▴' : '▾'}
        </span>
      )}

      {dropdownOpen && processes.length > 0 && (
        <div className="ai-running__dropdown">
          <div className="ai-running__dropdown-title">Active AI Processes</div>
          {processes.map(proc => {
            const elapsed = proc.startedAt ? now - new Date(proc.startedAt).getTime() : 0
            return (
              <button
                key={proc.id}
                className={`ai-running__dropdown-item ${proc.type === 'objective' ? 'ai-running__dropdown-item--clickable' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleClickProcess(proc) }}
              >
                <span className="ai-running__dropdown-type">{TYPE_ICONS[proc.type] || '🤖'}</span>
                <span className={`ai-running__dot ai-running__dot--${proc.health}`} />
                <span className="ai-running__dropdown-label">{proc.title}</span>
                {proc.taskCount > 0 && (
                  <span className="ai-running__dropdown-tasks">
                    {proc.completedTasks}/{proc.taskCount}
                  </span>
                )}
                <span className={`ai-running__dropdown-time ai-running__dropdown-time--${proc.health}`}>
                  {formatElapsed(elapsed)}
                </span>
              </button>
            )
          })}
          {(staleCount + stuckCount) > 0 && (
            <div style={{
              padding: '6px 10px', margin: '4px 6px',
              borderRadius: 4, background: 'rgba(251,191,36,0.06)',
              border: '1px solid rgba(251,191,36,0.12)',
              fontSize: 10, color: '#fbbf24', fontWeight: 500,
            }}>
              {staleCount + stuckCount} stale process{(staleCount + stuckCount) !== 1 ? 'es' : ''} — check objectives
            </div>
          )}
          <button
            className="ai-running__dropdown-viewall"
            onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); navigate('/objectives') }}
          >
            View objectives →
          </button>
        </div>
      )}
    </span>
  )
}

export default AIRunningIndicator
