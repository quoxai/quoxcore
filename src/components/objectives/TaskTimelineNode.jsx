/**
 * TaskTimelineNode — Shared task timeline component for objectives
 *
 * Extracted from ObjectivesView.jsx (UX-0B).
 * Enhanced with live heartbeat ribbon + elapsed timer (Batch A).
 *
 * Props:
 *   task      — { id, title, agent_id, status, result, duration_ms, tokens_used, prompt, started_at }
 *   isLast    — hide the connecting line after the last task
 *   isPreview — preview mode: show prompt, hide retry/skip buttons
 *   onRetry   — callback(taskId) for retry button
 *   onSkip    — callback(taskId) for skip button
 *   heartbeat — { elapsed_ms, ts } from useObjectiveManager taskHeartbeats (optional)
 *   now       — Date.now() tick from useObjectiveManager (optional)
 */

import { useNavigate } from 'react-router-dom'
import Badge from '../ui/Badge'
import Button from '../ui/Button'
import MarkdownContent from '../ui/MarkdownContent'
import { HeartbeatRibbon } from '../orchestration'

const TASK_STATUS_CONFIG = {
  pending:       { label: 'Pending',   badgeColor: 'default', icon: '○' },
  running:       { label: 'Running',   badgeColor: 'blue',    icon: '◉' },
  waiting_child: { label: 'Waiting',   badgeColor: 'amber',   icon: '⏳' },
  completed:     { label: 'Done',      badgeColor: 'green',   icon: '●' },
  failed:        { label: 'Failed',    badgeColor: 'red',     icon: '✕' },
  skipped:       { label: 'Skipped',   badgeColor: 'default', icon: '⊘' },
  cancelled:     { label: 'Cancelled', badgeColor: 'default', icon: '⊘' },
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return null
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return `${min}m ${sec}s`
}

function getHeartbeatState(heartbeat, now) {
  if (!heartbeat) return 'idle'
  const age = (now || Date.now()) - heartbeat.ts
  if (age < 30000) return 'fresh'
  if (age < 45000) return 'warming'
  if (age < 90000) return 'stale'
  return 'dead'
}

// ─── Browser-Q Result Summary ───────────────────────────────────────

function BrowserQResultSummary({ task, objectiveId }) {
  const navigate = useNavigate()
  let parsed = null
  try {
    parsed = typeof task.result === 'string' ? JSON.parse(task.result) : task.result
  } catch { /* not JSON */ }
  if (!parsed) return null

  const actionLog = parsed.action_log || []
  const objectiveMet = parsed.objective_met
  const finalReasoning = parsed.final_reasoning || ''
  const iterations = parsed.iterations || actionLog.length
  const successCount = actionLog.filter(a => a.success !== false).length

  return (
    <div style={{
      marginTop: 6, padding: '8px 10px', borderRadius: 8,
      background: objectiveMet ? 'rgba(48,255,144,0.04)' : 'rgba(239,68,68,0.04)',
      border: `1px solid ${objectiveMet ? 'rgba(48,255,144,0.12)' : 'rgba(239,68,68,0.12)'}`,
    }}>
      {/* Summary line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
        <span style={{ color: objectiveMet ? '#30ff90' : '#ef4444', fontWeight: 700 }}>
          {objectiveMet ? '\u2713 Objective met' : '\u2717 Objective not met'}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.6)', fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>
          {successCount}/{iterations} actions
        </span>
      </div>

      {/* Final reasoning preview */}
      {finalReasoning && (
        <div style={{ fontSize: 11, color: '#fff', marginTop: 4, lineHeight: 1.4 }}>
          {finalReasoning.length > 120 ? finalReasoning.slice(0, 120) + '...' : finalReasoning}
        </div>
      )}

      {/* Action badges */}
      {actionLog.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
          {actionLog.slice(0, 6).map((a, i) => (
            <span key={i} style={{
              fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
              fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase',
              background: a.success !== false ? 'rgba(48,255,144,0.08)' : 'rgba(239,68,68,0.08)',
              color: a.success !== false ? '#30ff90' : '#ef4444',
            }}>
              {a.action}
            </span>
          ))}
          {actionLog.length > 6 && (
            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>+{actionLog.length - 6} more</span>
          )}
        </div>
      )}

      {/* View Run link */}
      {objectiveId && (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/browser-q/run/${objectiveId}`) }}
          style={{
            marginTop: 6, padding: '3px 10px', borderRadius: 6, fontSize: 10, fontWeight: 600,
            cursor: 'pointer', border: '1px solid rgba(6,182,212,0.25)',
            background: 'rgba(6,182,212,0.08)', color: '#06b6d4',
          }}
        >
          View in Browser-Q
        </button>
      )}
    </div>
  )
}

export default function TaskTimelineNode({ task, isLast, onRetry, onSkip, isPreview, heartbeat, now }) {
  const cfg = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.pending
  const isRunning = task.status === 'running'

  // Live elapsed for running tasks
  let liveElapsed = null
  if (isRunning && heartbeat) {
    liveElapsed = heartbeat.elapsed_ms + ((now || Date.now()) - heartbeat.ts)
  } else if (isRunning && task.started_at) {
    liveElapsed = (now || Date.now()) - new Date(task.started_at).getTime()
  }

  const hbState = isRunning ? getHeartbeatState(heartbeat, now) : 'idle'

  return (
    <div className="obj-timeline-node" role="listitem">
      {/* Timeline line + dot */}
      <div className="obj-timeline-track">
        <div className={`obj-timeline-dot obj-timeline-dot-${task.status}`} aria-hidden="true">
          {cfg.icon}
        </div>
        {!isLast && <div className="obj-timeline-line" />}
      </div>

      {/* Content */}
      <div className="obj-timeline-content" style={{ paddingBottom: isLast ? 0 : 16 }}>
        <div className="obj-timeline-header">
          <Badge color={cfg.badgeColor} pill>{task.agent_id}</Badge>
          <span className="obj-text-sm obj-text-primary" style={{ fontWeight: 500 }}>{task.title}</span>

          {/* Live elapsed timer for running tasks */}
          {isRunning && liveElapsed != null && (
            <span style={{
              fontSize: 11, fontWeight: 500,
              fontFamily: 'var(--m-font-mono, monospace)',
              fontVariantNumeric: 'tabular-nums',
              color: hbState === 'fresh' ? '#60a5fa' : hbState === 'warming' ? '#f97316' : hbState === 'stale' ? '#f59e0b' : '#ef4444',
              marginLeft: 'auto',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              {formatDuration(liveElapsed)}
              {hbState === 'stale' && <span style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>STALE</span>}
              {hbState === 'dead' && <span style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, color: '#ef4444' }}>UNRESPONSIVE</span>}
            </span>
          )}
        </div>

        {/* Heartbeat ribbon for running tasks */}
        {isRunning && !isPreview && (
          <div style={{ margin: '4px 0' }}>
            <HeartbeatRibbon state={hbState} />
          </div>
        )}

        {/* Preview: show prompt */}
        {isPreview && task.prompt && (
          <details className="obj-preview-prompt">
            <summary className="obj-text-xs obj-text-secondary" style={{ cursor: 'pointer' }}>Show prompt</summary>
            <pre className="obj-code-block">{task.prompt}</pre>
          </details>
        )}

        {/* Duration + tokens (completed/failed tasks) */}
        {!isRunning && task.duration_ms > 0 && (
          <span className="obj-text-xs obj-text-secondary">
            {formatDuration(task.duration_ms)}
            {task.tokens_used > 0 && ` · ${task.tokens_used.toLocaleString()} tokens`}
          </span>
        )}

        {/* Failed: error preview (truncated) */}
        {task.status === 'failed' && task.result && (
          <div className="obj-error-block">
            {task.result.length > 200 ? task.result.slice(0, 200) + '...' : task.result}
          </div>
        )}

        {/* Completed: browser-q gets rich summary, others get generic preview */}
        {task.status === 'completed' && task.result && (
          task.agent_id === 'browser-q' ? (
            <BrowserQResultSummary task={task} objectiveId={task.objective_id} />
          ) : (() => {
            const text = typeof task.result === 'string' ? task.result : JSON.stringify(task.result)
            const firstLine = (text.split('\n')[0] || '').trim()
            const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine
            return (
              <>
                {preview && (
                  <div className="obj-text-xs" style={{ color: 'rgba(255,255,255,0.6)', marginTop: 4, lineHeight: 1.4 }}>
                    {preview}
                  </div>
                )}
                {text.length > preview.length && (
                  <details style={{ marginTop: 4 }}>
                    <summary className="obj-text-xs obj-text-secondary" style={{ cursor: 'pointer' }}>Full result</summary>
                    <MarkdownContent compact>{task.result}</MarkdownContent>
                  </details>
                )}
              </>
            )
          })()
        )}

        {/* Failed actions: retry + skip (hidden in preview mode) */}
        {task.status === 'failed' && !isPreview && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <Button variant="outline-blue" size="xs" onClick={() => onRetry(task.id)}>Retry</Button>
            <Button variant="outline" size="xs" onClick={() => onSkip(task.id)}>Skip</Button>
          </div>
        )}
      </div>
    </div>
  )
}
