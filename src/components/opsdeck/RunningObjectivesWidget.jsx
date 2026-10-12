/**
 * RunningObjectivesWidget — EUX-5: Compact running objectives strip
 *
 * Shows all currently running objectives with live progress bars,
 * current agent, and click-to-navigate. Sits below SystemPulseBar
 * in the OpsDeck view.
 *
 * Props:
 *   objectives — full objectives array from useOpsDeckState
 *   onNavigate — (objectiveId) => navigate callback
 */

import { useState, useEffect } from 'react'

/**
 * Derive real completed/total task counts for an objective.
 *
 * The /api/objectives LIST endpoint returns summary rows only — no
 * per-task tasks[] array — so `obj.tasks` is always undefined here in
 * practice. Previously this widget filtered an always-empty tasks[] array,
 * which meant "completed" was always 0 no matter how far along the
 * objective really was. When per-task detail IS present (e.g. a future
 * caller hydrates it), use it; otherwise fall back to the real aggregate
 * counters the summary row already carries (tasks_completed/task_count)
 * rather than silently showing a false 0/N.
 */
export function computeObjectiveProgress(obj) {
  const tasks = Array.isArray(obj?.tasks) ? obj.tasks : null
  if (tasks) {
    const completed = tasks.filter(t => t.status === 'completed').length
    const total = obj.task_count || tasks.length || 0
    return { completed, total, hasTaskDetail: true }
  }
  const completed = obj?.tasks_completed ?? obj?.completed_count ?? 0
  const total = obj?.task_count || 0
  return { completed, total, hasTaskDetail: false }
}

function formatElapsed(startedAt) {
  if (!startedAt) return null
  const elapsed = Date.now() - new Date(startedAt).getTime()
  if (elapsed < 0) return '0s'
  if (elapsed < 60000) return `${Math.floor(elapsed / 1000)}s`
  if (elapsed < 3600000) {
    const min = Math.floor(elapsed / 60000)
    const sec = Math.floor((elapsed % 60000) / 1000)
    return `${min}m ${sec}s`
  }
  const hr = Math.floor(elapsed / 3600000)
  const min = Math.floor((elapsed % 3600000) / 60000)
  return `${hr}h ${min}m`
}

export default function RunningObjectivesWidget({ objectives, onNavigate }) {
  // Force re-render every 5s for elapsed time updates
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 5000)
    return () => clearInterval(id)
  }, [])

  const running = (objectives || [])
    .filter(o => o.status === 'running' || o.status === 'in_progress')

  if (running.length === 0) return null

  return (
    <div style={{
      display: 'flex', gap: 6, padding: '4px 12px 6px',
      overflowX: 'auto', flexShrink: 0,
    }}>
      {/* Label */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        fontSize: 10, fontWeight: 600, color: 'rgba(161,161,170,0.4)',
        textTransform: 'uppercase', letterSpacing: '0.05em',
        whiteSpace: 'nowrap', flexShrink: 0, paddingRight: 4,
      }}>
        <div style={{
          width: 5, height: 5, borderRadius: '50%', background: '#6366f1',
          animation: 'eux-widget-pulse 2s ease-in-out infinite',
        }} />
        {running.length} active
      </div>

      {/* Objective cards */}
      {running.map(obj => {
        const { completed, total, hasTaskDetail } = computeObjectiveProgress(obj)
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0
        // Current-agent line needs per-task detail (agent_id per task), which
        // the list endpoint doesn't provide — honestly omit it rather than
        // rendering nothing/wrong when that detail isn't available.
        const runningTask = hasTaskDetail ? (obj.tasks || []).find(t => t.status === 'running') : null
        const elapsed = formatElapsed(obj.started_at || obj.created_at)

        return (
          <button
            key={obj.id}
            onClick={() => onNavigate?.(obj.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '5px 10px', borderRadius: 6,
              background: 'rgba(99, 102, 241, 0.06)',
              border: '1px solid rgba(99, 102, 241, 0.12)',
              cursor: 'pointer', flexShrink: 0,
              maxWidth: 320, transition: 'background 0.15s, border-color 0.15s',
              textAlign: 'left', color: 'inherit', font: 'inherit',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.12)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.25)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.06)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.12)' }}
            title={`${obj.title} — ${completed}/${total} tasks`}
          >
            {/* Mini progress ring */}
            <svg width="20" height="20" viewBox="0 0 20 20" style={{ flexShrink: 0 }}>
              <circle cx="10" cy="10" r="8" fill="none" stroke="rgba(99,102,241,0.15)" strokeWidth="2" />
              <circle cx="10" cy="10" r="8" fill="none" stroke="#6366f1" strokeWidth="2"
                strokeDasharray={`${pct * 0.5} 50`} strokeLinecap="round"
                transform="rotate(-90 10 10)"
                style={{ transition: 'stroke-dasharray 0.5s ease' }}
              />
              <text x="10" y="10" textAnchor="middle" dy="0.35em"
                style={{ fontSize: 6, fontWeight: 700, fill: 'rgba(165,180,252,0.9)', fontFamily: 'var(--m-font-mono, monospace)' }}>
                {pct}
              </text>
            </svg>

            {/* Title + current task */}
            <div style={{ flex: '1 1 0', minWidth: 0 }}>
              <div style={{
                fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.8)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {obj.title}
              </div>
              {runningTask && (
                <div style={{
                  fontSize: 9, color: 'rgba(161,161,170,0.5)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  display: 'flex', gap: 4, alignItems: 'center',
                }}>
                  <span style={{ color: 'rgba(165,180,252,0.7)', fontWeight: 600 }}>
                    {(runningTask.agent_id || '').toUpperCase()}
                  </span>
                  {runningTask.title}
                </div>
              )}
            </div>

            {/* Stats */}
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
              flexShrink: 0, gap: 1,
            }}>
              <span style={{
                fontSize: 10, fontWeight: 600, color: 'rgba(165,180,252,0.8)',
                fontFamily: 'var(--m-font-mono, monospace)',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {completed}/{total}
              </span>
              {elapsed && (
                <span style={{
                  fontSize: 9, color: 'rgba(161,161,170,0.4)',
                  fontFamily: 'var(--m-font-mono, monospace)',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {elapsed}
                </span>
              )}
            </div>
          </button>
        )
      })}

      <style>{`
        @keyframes eux-widget-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  )
}
