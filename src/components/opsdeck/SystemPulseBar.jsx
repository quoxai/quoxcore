/**
 * SystemPulseBar V2 — Top status strip for OpsDeck
 *
 * Shows summary of all active objectives, total agent utilization,
 * and connection state. Multi-objective aware.
 */

import { useState, useEffect } from 'react'

/**
 * Find the earliest start time among currently active (running/in_progress)
 * objectives. Returns null when there's no meaningful start to derive from
 * (no active objectives, or none carry a started_at/created_at timestamp).
 */
export function findEarliestActiveStart(objectives) {
  const active = (objectives || []).filter(
    (o) => o.status === 'running' || o.status === 'in_progress'
  )
  const timestamps = active
    .map((o) => o.started_at || o.created_at)
    .filter(Boolean)
    .map((ts) => new Date(ts).getTime())
    .filter((t) => !Number.isNaN(t))
  if (timestamps.length === 0) return null
  return Math.min(...timestamps)
}

/**
 * Format elapsed time since startMs as a short human string, or null when
 * there's no real start time to measure from — callers must not render a
 * fabricated timer in that case.
 */
export function formatElapsedSince(startMs, nowMs = Date.now()) {
  if (!startMs) return null
  const secs = Math.floor((nowMs - startMs) / 1000)
  if (secs < 0) return null
  const mins = Math.floor(secs / 60)
  const hrs = Math.floor(mins / 60)
  if (hrs > 0) return `${hrs}h ${mins % 60}m`
  if (mins > 0) return `${mins}m ${secs % 60}s`
  return `${secs}s`
}

function ConnectionDot({ state }) {
  const color = state === 'connected' ? '#22c55e'
    : state === 'connecting' ? '#eab308'
    : state === 'error' ? '#ef4444'
    : 'rgba(255,255,255,0.3)'

  return (
    <span className="opsdeck-pulse__conn-dot" style={{ '--dot-color': color }}>
      <span className="opsdeck-pulse__conn-ping" />
    </span>
  )
}

export default function SystemPulseBar({
  groups,
  objectives,
  connectionState,
  totalAgents,
  activeAgents,
  onToggleWallboard,
  isWallboard,
  onClearCompleted,
}) {
  // Re-render every second so the elapsed label ticks — the value itself is
  // derived from the earliest active objective's real started_at, not from
  // when this component happened to mount.
  const [, forceTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const earliestStart = findEarliestActiveStart(objectives)
  const elapsed = formatElapsedSince(earliestStart)

  const totalTasks = groups.reduce((n, g) => n + (g.objective.taskCount || 0), 0)
  const doneTasks = groups.reduce((n, g) => n + (g.objective.completedCount || 0), 0)

  return (
    <div className="opsdeck-pulse">
      <div className="opsdeck-pulse__left">
        {groups.length > 0 ? (
          <span className="opsdeck-pulse__title">
            {groups.length} objective{groups.length !== 1 ? 's' : ''} active
          </span>
        ) : (
          <span className="opsdeck-pulse__title" style={{ opacity: 0.6 }}>
            OpsDeck {objectives?.length > 0 ? `\u2014 ${objectives.length} objective${objectives.length !== 1 ? 's' : ''} on record` : '\u2014 idle'}
          </span>
        )}
      </div>

      <div className="opsdeck-pulse__center">
        {totalTasks > 0 && (
          <>
            <div className="opsdeck-pulse__progress-bar">
              {Array.from({ length: Math.min(totalTasks, 30) }, (_, i) => (
                <div
                  key={i}
                  className={`opsdeck-pulse__segment ${i < doneTasks ? 'opsdeck-pulse__segment--done' : ''}`}
                />
              ))}
              {totalTasks > 30 && (
                <span className="opsdeck-pulse__overflow">+{totalTasks - 30}</span>
              )}
            </div>
            <span className="opsdeck-pulse__progress-text">{doneTasks}/{totalTasks} tasks</span>
          </>
        )}
      </div>

      <div className="opsdeck-pulse__right">
        <span className="opsdeck-pulse__util">{activeAgents}/{totalAgents} active</span>
        {elapsed && <span className="opsdeck-pulse__elapsed">{elapsed}</span>}
        {onClearCompleted && groups.some(g => !['running', 'in_progress', 'decomposing'].includes(g.objective.status)) && (
          <button
            className="opsdeck-pulse__wallboard-btn"
            onClick={onClearCompleted}
            title="Clear non-running objectives from view"
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            Clear done
          </button>
        )}
        <button
          className="opsdeck-pulse__wallboard-btn"
          onClick={onToggleWallboard}
          title={isWallboard ? 'Exit wallboard' : 'Wallboard mode'}
        >
          {isWallboard ? '\u229F' : '\u229E'}
        </button>
        <ConnectionDot state={connectionState} />
      </div>
    </div>
  )
}
