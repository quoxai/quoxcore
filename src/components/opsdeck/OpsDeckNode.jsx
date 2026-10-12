/**
 * OpsDeckNode — Custom React Flow node for OpsDeck
 *
 * Circle with scanning conic gradient glow.
 * Orchestrator variant has progress ring showing task completion.
 * Zoom-adaptive: labels hide at far zoom, details at close zoom.
 * Single-click focuses cluster AND opens detail panel.
 * Hover tooltip shows agent info at any zoom level.
 * Dot color uses cluster accent; state shown via ring indicator.
 */

import { memo, useState, useEffect, useRef } from 'react'
import { Handle, Position } from '@xyflow/react'

const STATE_LABELS = {
  idle: 'Standing by',
  thinking: 'Thinking...',
  executing: 'Executing',
  reading: 'Reading',
  writing: 'Writing',
  waiting_input: 'Needs input',
  waiting_permission: 'Needs approval',
  blocked: 'Blocked',
  handing_off: 'Handing off',
  done: 'Complete',
}

/** SVG progress ring for orchestrator nodes */
function ProgressRing({ progress, size, color }) {
  if (!progress && progress !== 0) return null
  const strokeWidth = 2.5
  const radius = (size / 2) + 6
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - Math.min(progress, 1))

  return (
    <svg
      className="opsdeck-node__progress-ring"
      width={radius * 2 + strokeWidth * 2}
      height={radius * 2 + strokeWidth * 2}
      style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', pointerEvents: 'none' }}
    >
      {/* Background track */}
      <circle
        cx={radius + strokeWidth}
        cy={radius + strokeWidth}
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth={strokeWidth}
      />
      {/* Progress arc */}
      <circle
        cx={radius + strokeWidth}
        cy={radius + strokeWidth}
        r={radius}
        fill="none"
        stroke={color || 'var(--state-done)'}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${radius + strokeWidth} ${radius + strokeWidth})`}
        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
      />
    </svg>
  )
}

function OpsDeckNode({ data }) {
  const {
    label, state = 'idle', isOrchestrator, currentTask,
    completedTasks = 0, failedTasks = 0, stale,
    objectiveTitle, objectiveStatus, accentColor, zoom = 1,
    dimmed, highlighted, onNodeClick, onDetailOpen, clusterId,
    progress, taskCount, completedCount,
    agentId, role, description,
  } = data

  const [elapsed, setElapsed] = useState(null)
  const intervalRef = useRef(null)

  useEffect(() => {
    if (currentTask?.startedAt) {
      const update = () => {
        const secs = Math.floor((Date.now() - currentTask.startedAt) / 1000)
        const mins = Math.floor(secs / 60)
        const r = secs % 60
        setElapsed(mins > 0 ? `${mins}m ${r}s` : `${r}s`)
      }
      update()
      intervalRef.current = setInterval(update, 1000)
      return () => clearInterval(intervalRef.current)
    } else {
      setElapsed(null)
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [currentTask?.startedAt])

  const showLabel = zoom >= 0.45
  const showDetail = zoom >= 0.8
  const showStats = zoom >= 1.0
  const showProgressRing = isOrchestrator && taskCount > 0 && zoom >= 0.5

  const cls = [
    'opsdeck-node',
    isOrchestrator && 'opsdeck-node--orch',
    stale && 'opsdeck-node--stale',
    dimmed && 'opsdeck-node--dimmed',
    highlighted && 'opsdeck-node--highlighted',
  ].filter(Boolean).join(' ')

  const [hovered, setHovered] = useState(false)

  const handleClick = (e) => {
    e.stopPropagation()
    onNodeClick?.(clusterId)
    onDetailOpen?.({
      label, state, isOrchestrator, currentTask,
      completedTasks, failedTasks, stale,
      objectiveTitle, objectiveStatus, accentColor,
      progress, taskCount, completedCount,
      agentId, role, description,
      taskHistory: data.taskHistory || [],
    })
  }

  // Determine state ring class
  const activeStates = ['thinking', 'executing', 'reading', 'writing']
  const isActive = activeStates.includes(state)
  const isBlocked = state === 'blocked' || state === 'failed'
  const isDone = state === 'done'
  const isStaleState = stale
  const ringCls = [
    'opsdeck-node__state-ring',
    isActive && 'opsdeck-node__state-ring--active',
    isBlocked && 'opsdeck-node__state-ring--blocked',
    isDone && 'opsdeck-node__state-ring--done',
    isStaleState && 'opsdeck-node__state-ring--stale',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={cls}
      data-state={state}
      style={accentColor ? { '--cluster-accent': accentColor } : undefined}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Handle type="target" position={Position.Top} className="opsdeck-handle" />

      {/* Hover tooltip — always visible on hover regardless of zoom */}
      {hovered && (
        <div className="opsdeck-node__tooltip">
          <div className="opsdeck-node__tooltip-name">{label}</div>
          <div className="opsdeck-node__tooltip-state">{STATE_LABELS[state] || state}</div>
          {currentTask?.title && (
            <div className="opsdeck-node__tooltip-task">{currentTask.title}</div>
          )}
          {(completedTasks > 0 || failedTasks > 0) && (
            <div className="opsdeck-node__tooltip-stats">
              {completedTasks} completed, {failedTasks} failed
            </div>
          )}
        </div>
      )}

      <div className="opsdeck-node__circle">
        <div className={ringCls} style={accentColor ? { '--ring-accent': accentColor } : undefined} />
        <div className="opsdeck-node__dot" />
        {showProgressRing && (
          <ProgressRing progress={progress} size={48} color={accentColor} />
        )}
      </div>

      {showLabel && (
        <div className="opsdeck-node__label">{label}</div>
      )}

      {/* Orchestrator status badge — always visible, front and centre */}
      {isOrchestrator && objectiveStatus && showLabel && (
        <div className="opsdeck-node__status-badge" data-status={objectiveStatus}>
          {objectiveStatus === 'running' ? '\u25B6 Running'
            : objectiveStatus === 'completed' ? '\u2713 Done'
            : objectiveStatus === 'completed_with_errors' ? '\u26A0 Partial'
            : objectiveStatus === 'failed' ? '\u2717 Failed'
            : objectiveStatus === 'decomposed' ? '\u23F8 Awaiting approval'
            : objectiveStatus === 'decomposing' ? '\u2026 Planning'
            : objectiveStatus === 'pending' ? '\u25CB Pending'
            : objectiveStatus === 'paused' ? '\u23F8 Paused'
            : objectiveStatus === 'cancelled' ? '\u2014 Cancelled'
            : objectiveStatus}
          {taskCount > 0 && ` \u00B7 ${completedCount}/${taskCount}`}
        </div>
      )}

      {showDetail && (
        <div className="opsdeck-node__detail">
          {isOrchestrator && objectiveTitle && (
            <div className="opsdeck-node__objective" data-status={objectiveStatus}>
              {objectiveTitle}
            </div>
          )}
          {isOrchestrator && showStats && taskCount > 0 && (
            <div className="opsdeck-node__progress-text">
              {completedCount}/{taskCount} tasks
            </div>
          )}
          {!isOrchestrator && (
            <div className="opsdeck-node__task">
              {currentTask?.title || STATE_LABELS[state] || 'Standing by'}
            </div>
          )}
          {!isOrchestrator && elapsed && (
            <div className="opsdeck-node__elapsed">{elapsed}</div>
          )}
        </div>
      )}

      {showStats && !isOrchestrator && (completedTasks > 0 || failedTasks > 0) && !currentTask && (
        <div className="opsdeck-node__stats">
          {completedTasks > 0 && <span className="opsdeck-node__stat--ok">{completedTasks}</span>}
          {failedTasks > 0 && <span className="opsdeck-node__stat--fail">{failedTasks}</span>}
        </div>
      )}

      {stale && showLabel && <div className="opsdeck-node__stale">STALE</div>}

      {(state === 'waiting_input' || state === 'waiting_permission') && showLabel && (
        <div className="opsdeck-node__hitl-badge">
          {state === 'waiting_permission' ? '\u26A0 Approval' : '\u26A0 Input'}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="opsdeck-handle" />
    </div>
  )
}

export default memo(OpsDeckNode)
