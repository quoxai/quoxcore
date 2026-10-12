/**
 * TaskWaterfallChart — Horizontal waterfall showing task execution timeline
 *
 * Each bar represents a task, colour-coded by agent. Parallel tasks stack vertically.
 * Failed tasks show red with hatched pattern. Retries shown with dashed connector.
 *
 * @param {Array} tasks — [{ id, title, agentId, agentColor, status, startedAt, completedAt, durationMs, retryOf }]
 * @param {number} totalDurationMs — total objective duration for scale
 * @param {Function} [onTaskClick] — callback(taskId)
 * @param {number} [height] — override height (default: auto)
 */

import { useMemo } from 'react'

const ROW_HEIGHT = 28
const ROW_GAP = 4
const AXIS_HEIGHT = 24
const LEFT_LABEL_WIDTH = 80

function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

export default function TaskWaterfallChart({ tasks = [], totalDurationMs = 0, onTaskClick, height: overrideHeight }) {
  // Calculate layout
  const { rows, maxTime } = useMemo(() => {
    if (tasks.length === 0 || totalDurationMs === 0) return { rows: [], maxTime: 0 }

    const baseTime = tasks.reduce((min, t) => {
      const ts = t.startedAt ? new Date(t.startedAt).getTime() : Infinity
      return Math.min(min, ts)
    }, Infinity)

    const mapped = tasks.map(t => {
      const start = t.startedAt ? new Date(t.startedAt).getTime() - baseTime : 0
      const duration = t.durationMs || 0
      return { ...t, startMs: start, endMs: start + duration }
    })

    const maxT = Math.max(totalDurationMs, ...mapped.map(t => t.endMs))

    // Assign rows — simple greedy: each task goes in the first row where it fits
    const rowEnds = []
    const rowAssignments = mapped.map(t => {
      for (let r = 0; r < rowEnds.length; r++) {
        if (t.startMs >= rowEnds[r]) {
          rowEnds[r] = t.endMs
          return r
        }
      }
      rowEnds.push(t.endMs)
      return rowEnds.length - 1
    })

    return {
      rows: mapped.map((t, i) => ({ ...t, row: rowAssignments[i] })),
      maxTime: maxT,
    }
  }, [tasks, totalDurationMs])

  if (rows.length === 0) return null

  const rowCount = Math.max(...rows.map(r => r.row)) + 1
  const chartHeight = overrideHeight || (rowCount * (ROW_HEIGHT + ROW_GAP) + AXIS_HEIGHT + 8)

  // Time axis ticks
  const tickCount = 5
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (maxTime / tickCount) * i)

  return (
    <div style={{
      width: '100%',
      height: chartHeight,
      position: 'relative',
      background: 'rgba(255,255,255,0.01)',
      borderRadius: 6,
      border: '1px solid rgba(255,255,255,0.04)',
      overflow: 'hidden',
    }}>
      {/* Bars */}
      <div style={{
        position: 'absolute',
        top: 4,
        left: LEFT_LABEL_WIDTH,
        right: 8,
        bottom: AXIS_HEIGHT,
      }}>
        {rows.map((task) => {
          const leftPct = maxTime > 0 ? (task.startMs / maxTime * 100) : 0
          const widthPct = maxTime > 0 ? (Math.max(task.durationMs || 1, maxTime * 0.005) / maxTime * 100) : 0
          const top = task.row * (ROW_HEIGHT + ROW_GAP)

          const isFailed = task.status === 'failed'
          const isRunning = task.status === 'running'
          const barColor = isFailed ? '#ef4444' : (task.agentColor || '#3b82f6')

          return (
            <div
              key={task.id}
              title={`${task.title} (${task.agentId}) — ${formatTime(task.durationMs)}`}
              onClick={onTaskClick ? () => onTaskClick(task.id) : undefined}
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                width: `${Math.max(widthPct, 0.5)}%`,
                top,
                height: ROW_HEIGHT,
                background: isFailed
                  ? `repeating-linear-gradient(45deg, ${barColor}40, ${barColor}40 2px, ${barColor}20 2px, ${barColor}20 4px)`
                  : barColor,
                borderRadius: 3,
                opacity: task.status === 'skipped' ? 0.3 : 0.85,
                cursor: onTaskClick ? 'pointer' : 'default',
                display: 'flex',
                alignItems: 'center',
                paddingLeft: 4,
                overflow: 'hidden',
                transition: 'opacity 0.15s',
              }}
            >
              <span style={{
                fontSize: 9, color: '#fff', fontWeight: 500,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                textShadow: '0 1px 2px rgba(0,0,0,0.5)',
              }}>
                {task.agentId}
              </span>
            </div>
          )
        })}
      </div>

      {/* Agent labels (left) */}
      <div style={{
        position: 'absolute', top: 4, left: 0, width: LEFT_LABEL_WIDTH, bottom: AXIS_HEIGHT,
      }}>
        {rows.map((task) => {
          const top = task.row * (ROW_HEIGHT + ROW_GAP)
          // Only show label for first task in each row
          const isFirst = rows.findIndex(r => r.row === task.row) === rows.indexOf(task)
          if (!isFirst) return null
          return (
            <div key={`label-${task.row}`} style={{
              position: 'absolute', top, height: ROW_HEIGHT,
              display: 'flex', alignItems: 'center',
              paddingLeft: 6,
              fontSize: 9, color: 'rgba(255,255,255,0.5)',
              fontFamily: 'var(--m-font-mono, monospace)',
            }}>
              {task.agentId}
            </div>
          )
        })}
      </div>

      {/* Time axis */}
      <div style={{
        position: 'absolute', bottom: 0, left: LEFT_LABEL_WIDTH, right: 8,
        height: AXIS_HEIGHT,
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '0 2px',
      }}>
        {ticks.map((ms, i) => (
          <span key={i} style={{
            fontSize: 9, color: 'rgba(255,255,255,0.3)',
            fontFamily: 'var(--m-font-mono, monospace)',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {formatTime(ms)}
          </span>
        ))}
      </div>
    </div>
  )
}
