import React, { useMemo, useState, useCallback } from 'react'

/**
 * SwimlaneDiagram — Production swimlane chart for objective execution.
 *
 * Adapted from quox-remotion/src/visuals-dashboard/SwimlaneDiagram.jsx.
 * All Remotion deps removed. CSS transitions for hover, CSS animation for
 * running-task pulse. SVG-based rendering.
 *
 * Props:
 *   tasks         — array of { id, title, agentId, agentName, agentColor, status, startedAt, completedAt, durationMs }
 *   delegations   — array of { from, to, taskTitle, timestamp } (optional)
 *   totalDurationMs — total objective duration in ms
 *   width         — container width (default '100%')
 *   compact       — boolean for smaller version
 */

const LANE_HEIGHT = 60
const LANE_HEIGHT_COMPACT = 42
const LABEL_WIDTH = 110
const LABEL_WIDTH_COMPACT = 90
const TIMELINE_PADDING = 30
const TIMELINE_PADDING_COMPACT = 20

const STATUS_OPACITY = {
  completed: 0.7,
  running: 0.6,
  failed: 0.65,
  pending: 0.4,
}

// CSS keyframes injected once
const PULSE_KEYFRAMES = `
@keyframes swimlane-pulse-edge {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
@keyframes swimlane-failed-blink {
  0%, 100% { r: 3; }
  50% { r: 4.5; }
}
`

let stylesInjected = false
function injectStyles() {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = PULSE_KEYFRAMES
  document.head.appendChild(style)
}

function formatDuration(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}

function formatTimeAxis(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(0)}s`
  const m = s / 60
  return `${m.toFixed(1)}m`
}

const SwimlaneDiagram = ({
  tasks = [],
  delegations = [],
  totalDurationMs = 0,
  width = '100%',
  compact = false,
}) => {
  const [tooltip, setTooltip] = useState(null)

  React.useEffect(() => { injectStyles() }, [])

  const laneHeight = compact ? LANE_HEIGHT_COMPACT : LANE_HEIGHT
  const labelWidth = compact ? LABEL_WIDTH_COMPACT : LABEL_WIDTH
  const timelinePadding = compact ? TIMELINE_PADDING_COMPACT : TIMELINE_PADDING

  // Group tasks into lanes by agentId
  const lanes = useMemo(() => {
    const map = new Map()
    for (const task of tasks) {
      if (!map.has(task.agentId)) {
        map.set(task.agentId, {
          agentId: task.agentId,
          agentName: task.agentName || task.agentId,
          color: task.agentColor || '#06b6d4',
          tasks: [],
        })
      }
      map.get(task.agentId).tasks.push(task)
    }
    return Array.from(map.values())
  }, [tasks])

  // Derive handoff arrows from delegations
  const handoffs = useMemo(() => {
    if (!delegations || delegations.length === 0) return []
    const agentIndex = new Map()
    lanes.forEach((lane, i) => agentIndex.set(lane.agentId, i))

    return delegations
      .filter(d => agentIndex.has(d.from) && agentIndex.has(d.to))
      .map(d => ({
        fromLane: agentIndex.get(d.from),
        toLane: agentIndex.get(d.to),
        timeMs: d.timestamp,
        label: d.taskTitle || '',
      }))
  }, [delegations, lanes])

  // Find the earliest task start to use as origin
  const objectiveStart = useMemo(() => {
    let earliest = Infinity
    for (const task of tasks) {
      if (task.startedAt != null) {
        const t = typeof task.startedAt === 'number' ? task.startedAt : new Date(task.startedAt).getTime()
        if (t < earliest) earliest = t
      }
    }
    return earliest === Infinity ? 0 : earliest
  }, [tasks])

  const effectiveDuration = totalDurationMs || (() => {
    let latest = 0
    for (const task of tasks) {
      const start = task.startedAt != null
        ? (typeof task.startedAt === 'number' ? task.startedAt : new Date(task.startedAt).getTime())
        : 0
      const end = task.completedAt != null
        ? (typeof task.completedAt === 'number' ? task.completedAt : new Date(task.completedAt).getTime())
        : start + (task.durationMs || 0)
      const relative = end - objectiveStart
      if (relative > latest) latest = relative
    }
    return latest || 1000
  })()

  // Use a fixed internal SVG width for coordinate math; CSS scales it
  const svgWidth = 900
  const laneCount = lanes.length
  const svgHeight = laneCount * laneHeight + timelinePadding * 2 + 40
  const timelineWidth = svgWidth - labelWidth - 20

  function timeToX(ms) {
    return labelWidth + (ms / effectiveDuration) * timelineWidth
  }

  function laneToY(index) {
    return timelinePadding + 20 + index * laneHeight + laneHeight / 2
  }

  const handleBarEnter = useCallback((e, task) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setTooltip({
      x: rect.left + rect.width / 2,
      y: rect.top,
      title: task.title,
      status: task.status,
      duration: formatDuration(task.durationMs),
    })
  }, [])

  const handleBarLeave = useCallback(() => {
    setTooltip(null)
  }, [])

  // Compute task position helpers
  function getTaskTimes(task) {
    const start = task.startedAt != null
      ? (typeof task.startedAt === 'number' ? task.startedAt : new Date(task.startedAt).getTime())
      : objectiveStart
    const relStart = start - objectiveStart

    let relEnd
    if (task.completedAt != null) {
      const end = typeof task.completedAt === 'number' ? task.completedAt : new Date(task.completedAt).getTime()
      relEnd = end - objectiveStart
    } else if (task.durationMs) {
      relEnd = relStart + task.durationMs
    } else {
      // Running task with no end — extend to current duration
      relEnd = effectiveDuration
    }
    return { relStart, relEnd }
  }

  const tickCount = compact ? 5 : 7

  if (tasks.length === 0) {
    return (
      <div style={{
        width,
        padding: compact ? '12px' : '20px',
        color: 'rgba(255, 255, 255, 0.4)',
        fontFamily: 'monospace',
        fontSize: compact ? 10 : 11,
        textAlign: 'center',
      }}>
        No task data to display
      </div>
    )
  }

  return (
    <div style={{ width, position: 'relative' }}>
      <svg
        width="100%"
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        style={{ display: 'block' }}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Timeline ticks */}
        {Array.from({ length: tickCount }, (_, i) => {
          const t = (effectiveDuration / (tickCount - 1)) * i
          const x = timeToX(t)
          return (
            <g key={`tick-${i}`}>
              <line
                x1={x}
                y1={timelinePadding}
                x2={x}
                y2={svgHeight - timelinePadding}
                stroke="rgba(255,255,255,0.06)"
                strokeWidth={1}
              />
              <text
                x={x}
                y={timelinePadding - 4}
                fill="rgba(255,255,255,0.35)"
                fontSize={compact ? 8 : 9}
                fontFamily="monospace"
                textAnchor="middle"
              >
                {formatTimeAxis(t)}
              </text>
            </g>
          )
        })}

        {/* Lane backgrounds and labels */}
        {lanes.map((lane, li) => {
          const y = laneToY(li)
          return (
            <g key={`lane-${li}`}>
              <line
                x1={labelWidth - 10}
                y1={y + laneHeight / 2}
                x2={svgWidth - 10}
                y2={y + laneHeight / 2}
                stroke="rgba(255,255,255,0.04)"
                strokeWidth={1}
              />
              <text
                x={10}
                y={y + 4}
                fill={lane.color}
                fillOpacity={0.8}
                fontSize={compact ? 9 : 11}
                fontFamily="monospace"
                fontWeight={600}
              >
                {lane.agentName}
              </text>
            </g>
          )
        })}

        {/* Task bars */}
        {lanes.map((lane, li) =>
          lane.tasks.map((task, ti) => {
            const { relStart, relEnd } = getTaskTimes(task)
            const x1 = timeToX(relStart)
            const x2 = timeToX(relEnd)
            const y = laneToY(li)
            const barWidth = Math.max(x2 - x1, 4)
            const barHeight = compact ? 18 : 24
            const opacity = STATUS_OPACITY[task.status] || 0.6
            const isRunning = task.status === 'running'
            const isFailed = task.status === 'failed'

            return (
              <g
                key={`task-${li}-${ti}`}
                onMouseEnter={(e) => handleBarEnter(e, task)}
                onMouseLeave={handleBarLeave}
                style={{ cursor: 'pointer' }}
              >
                {/* Bar background */}
                <rect
                  x={x1}
                  y={y - barHeight / 2}
                  width={barWidth}
                  height={barHeight}
                  rx={4}
                  fill={lane.color}
                  fillOpacity={opacity * 0.25}
                  stroke={lane.color}
                  strokeOpacity={opacity * 0.5}
                  strokeWidth={1}
                  style={{ transition: 'fill-opacity 0.2s ease, stroke-opacity 0.2s ease' }}
                />
                {/* Bar fill */}
                <rect
                  x={x1}
                  y={y - barHeight / 2}
                  width={barWidth}
                  height={barHeight}
                  rx={4}
                  fill={lane.color}
                  fillOpacity={opacity * 0.15}
                  style={{ transition: 'fill-opacity 0.2s ease' }}
                />
                {/* Hover highlight (transparent rect on top for hover area) */}
                <rect
                  x={x1}
                  y={y - barHeight / 2}
                  width={barWidth}
                  height={barHeight}
                  rx={4}
                  fill="rgba(255, 255, 255, 0)"
                  className="swimlane-bar-hover"
                />
                {/* Task label */}
                {barWidth > 50 && (
                  <text
                    x={x1 + 6}
                    y={y + (compact ? 3 : 4)}
                    fill="rgba(255, 255, 255, 0.75)"
                    fontSize={compact ? 8 : 9}
                    fontFamily="monospace"
                  >
                    {task.title && task.title.length > Math.floor(barWidth / 6)
                      ? task.title.slice(0, Math.floor(barWidth / 6)) + '...'
                      : task.title}
                  </text>
                )}
                {/* Running pulse on right edge */}
                {isRunning && (
                  <rect
                    x={x1 + barWidth - 3}
                    y={y - barHeight / 2}
                    width={3}
                    height={barHeight}
                    rx={1}
                    fill={lane.color}
                    fillOpacity={0.8}
                    style={{ animation: 'swimlane-pulse-edge 1.2s ease-in-out infinite' }}
                  />
                )}
                {/* Failed indicator */}
                {isFailed && (
                  <circle
                    cx={x1 + barWidth - 10}
                    cy={y}
                    r={3}
                    fill="#ef4444"
                    fillOpacity={0.85}
                    style={{ animation: 'swimlane-failed-blink 2s ease-in-out infinite' }}
                  />
                )}
              </g>
            )
          })
        )}

        {/* Handoff arrows */}
        {handoffs.map((ho, hi) => {
          const relTime = ho.timeMs != null ? ho.timeMs - objectiveStart : effectiveDuration / 2
          const x = timeToX(Math.max(0, relTime))
          const y1 = laneToY(ho.fromLane)
          const y2 = laneToY(ho.toLane)
          const dir = y2 > y1 ? 1 : -1
          const curveOffset = 25 * dir

          const pathD = `M ${x} ${y1} C ${x + curveOffset} ${y1}, ${x + curveOffset} ${y2}, ${x} ${y2}`

          return (
            <g key={`handoff-${hi}`}>
              <path
                d={pathD}
                fill="none"
                stroke="rgba(255, 255, 255, 0.3)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
              <polygon
                points={`${x},${y2} ${x - 4},${y2 - 6 * dir} ${x + 4},${y2 - 6 * dir}`}
                fill="rgba(255, 255, 255, 0.4)"
              />
              {ho.label && !compact && (
                <text
                  x={x + curveOffset + 6}
                  y={(y1 + y2) / 2 + 3}
                  fill="rgba(255, 255, 255, 0.4)"
                  fontSize={8}
                  fontFamily="monospace"
                >
                  {ho.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div style={{
          position: 'fixed',
          left: tooltip.x,
          top: tooltip.y - 8,
          transform: 'translate(-50%, -100%)',
          background: 'rgba(10, 12, 20, 0.95)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: 6,
          padding: '6px 10px',
          pointerEvents: 'none',
          zIndex: 9999,
          fontFamily: 'monospace',
          fontSize: 11,
          color: 'rgba(255, 255, 255, 0.85)',
          whiteSpace: 'nowrap',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{tooltip.title}</div>
          <div style={{ display: 'flex', gap: 12 }}>
            <span style={{ color: 'rgba(255, 255, 255, 0.5)' }}>{tooltip.status}</span>
            <span>{tooltip.duration}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export default SwimlaneDiagram
