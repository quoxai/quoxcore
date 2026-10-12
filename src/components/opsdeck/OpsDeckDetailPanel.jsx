/**
 * OpsDeckDetailPanel — Slide-out panel showing node details
 *
 * Appears on the right when a node is double-clicked.
 * Shows agent info, capabilities, tools, task history, and stats.
 */

import { useState } from 'react'
import { agentRegistry } from '../../config/agentRegistry'
import { useAgentToolsTruth } from '../../services/agentToolsTruth'
import { useAuth } from '../../contexts/AuthContext'
import { cancelObjective } from '../../services/objectivesClient'
import ObjectiveControlBar from '../objectives/ObjectiveControlBar'
import { HeartbeatRibbon, AgentActivityPulse, SuccessRateRing, CommandStream } from '../orchestration'

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

function relativeTime(ts) {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diff < 60) return `${diff}s ago`
  const mins = Math.floor(diff / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

export default function OpsDeckDetailPanel({ node, onClose, events = [], objectiveId: panelObjectiveId }) {
  const { authFetch } = useAuth()
  const [actionError, setActionError] = useState(null)
  // Hooks must run unconditionally (before the `!node` early return below) —
  // safe to call with a null/undefined agentId.
  const toolsTruth = useAgentToolsTruth(node?.agentId)

  if (!node) return null

  const {
    label, state, isOrchestrator, currentTask,
    completedTasks, failedTasks, stale,
    objectiveId, objectiveTitle, objectiveStatus, accentColor,
    progress, taskCount, completedCount,
    agentId, role, description, taskHistory = [],
  } = node

  // Objective action handlers (orchestrator nodes only)
  const handleAction = async (fn) => {
    if (!objectiveId) return
    setActionError(null)
    try { await fn(authFetch, objectiveId) }
    catch (err) { setActionError(err.message) }
  }

  const pct = progress != null ? Math.round(progress * 100) : null

  // Look up registry entry for capabilities, collaborates. Tools come from
  // the runtime truth (AGENT-OVERHAUL-2), not the registry's declared list —
  // see agentToolsTruth.js.
  const regEntry = agentId ? agentRegistry?.agents?.[agentId] : null
  const capabilities = regEntry?.capabilities || []
  const tools = toolsTruth.tools
  const collaboratesWith = regEntry?.canDelegateTo || regEntry?.collaboratesWith || []

  // Filter and map events for the CommandStream live feed
  const filteredEvents = (isOrchestrator
    ? events.filter(evt => evt.objectiveId === (objectiveId || panelObjectiveId))
    : events.filter(evt => evt.agentId === agentId)
  ).map(evt => ({
    time: evt.time || evt.ts || evt.timestamp,
    level: evt.level || evt.type || 'info',
    source: evt.source || evt.agentId || evt.from || 'system',
    message: evt.message || evt.text || evt.description || '',
  }))

  return (
    <div className="opsdeck-detail" style={{ '--detail-accent': accentColor }}>
      <div className="opsdeck-detail__header">
        <div className="opsdeck-detail__glow-header" data-state={state} />
        <div className="opsdeck-detail__dot" data-state={state} />
        <div className="opsdeck-detail__title">{label}</div>
        <button className="opsdeck-detail__close" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {isOrchestrator && (
        <div className="opsdeck-detail__section">
          <div className="opsdeck-detail__label">Objective</div>
          <div className="opsdeck-detail__value">{objectiveTitle || 'None'}</div>
          {objectiveStatus && (
            <div className="opsdeck-detail__badge" data-status={objectiveStatus}>
              {objectiveStatus}
            </div>
          )}
          {pct != null && (
            <div className="opsdeck-detail__progress">
              <div className="opsdeck-detail__progress-bar">
                <div className="opsdeck-detail__progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="opsdeck-detail__progress-text">{completedCount}/{taskCount} tasks ({pct}%)</span>
            </div>
          )}
          {objectiveId && objectiveStatus && (
            <div style={{ marginTop: 10 }}>
              <ObjectiveControlBar
                status={objectiveStatus}
                onCancel={() => handleAction(cancelObjective)}
                onWatchOpsDeck={null}
              />
              {actionError && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--m-error)' }}>{actionError}</div>
              )}
            </div>
          )}
        </div>
      )}

      {isOrchestrator && (
        <div className="opsdeck-detail__section">
          <div className="opsdeck-detail__label">Live Feed</div>
          <CommandStream events={filteredEvents} maxVisible={8} variant="compact" />
        </div>
      )}

      <div className="opsdeck-detail__section">
        <div className="opsdeck-detail__label">Status</div>
        <div className="opsdeck-detail__state" data-state={state}>
          {STATE_LABELS[state] || state}
          {stale && <span className="opsdeck-detail__stale-tag">STALE</span>}
        </div>
      </div>

      {!isOrchestrator && (
        <>
          {role && (
            <div className="opsdeck-detail__section">
              <div className="opsdeck-detail__label">Role</div>
              <div className="opsdeck-detail__value">{role}</div>
            </div>
          )}
          {description && (
            <div className="opsdeck-detail__section">
              <div className="opsdeck-detail__label">Domains</div>
              <div className="opsdeck-detail__value opsdeck-detail__value--dim">{description}</div>
            </div>
          )}

          {capabilities.length > 0 && (
            <div className="opsdeck-detail__section">
              <div className="opsdeck-detail__label">Capabilities</div>
              <div className="opsdeck-detail__capabilities">
                {capabilities.map((cap, i) => (
                  <span key={i} className="opsdeck-detail__cap-tag">{cap}</span>
                ))}
              </div>
            </div>
          )}

          {tools.length > 0 && (
            <div className="opsdeck-detail__section">
              <div className="opsdeck-detail__label">
                Tools
                {toolsTruth.source === 'fallback' && (
                  <span className="opsdeck-detail__stale-tag">UNVERIFIED</span>
                )}
              </div>
              <div className="opsdeck-detail__capabilities">
                {tools.map((tool, i) => (
                  <span key={i} className="opsdeck-detail__tool-tag">{tool}</span>
                ))}
              </div>
            </div>
          )}

          {collaboratesWith.length > 0 && (
            <div className="opsdeck-detail__section">
              <div className="opsdeck-detail__label">Collaborates With</div>
              <div className="opsdeck-detail__capabilities">
                {collaboratesWith.slice(0, 8).map((id, i) => (
                  <span key={i} className="opsdeck-detail__cap-tag">{id}</span>
                ))}
                {collaboratesWith.length > 8 && (
                  <span className="opsdeck-detail__cap-tag">+{collaboratesWith.length - 8}</span>
                )}
              </div>
            </div>
          )}

          {currentTask && (
            <div className="opsdeck-detail__section">
              <div className="opsdeck-detail__label">Current Task</div>
              <div className="opsdeck-detail__value">{currentTask.title}</div>
              {state === 'executing' && <HeartbeatRibbon state="fresh" />}
            </div>
          )}

          {/* Live activity indicators */}
          <div className="opsdeck-detail__section" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <SuccessRateRing rate={(completedTasks || 0) / Math.max((completedTasks || 0) + (failedTasks || 0), 1)} size={36} />
            <AgentActivityPulse
              history={taskHistory.map(t => ({ success: t.status === 'completed', timestamp: t.ts }))}
              size="md"
            />
          </div>

          <div className="opsdeck-detail__section opsdeck-detail__stats-row">
            <div className="opsdeck-detail__stat">
              <div className="opsdeck-detail__stat-num opsdeck-detail__stat-num--ok">{completedTasks || 0}</div>
              <div className="opsdeck-detail__stat-label">completed</div>
            </div>
            <div className="opsdeck-detail__stat">
              <div className="opsdeck-detail__stat-num opsdeck-detail__stat-num--fail">{failedTasks || 0}</div>
              <div className="opsdeck-detail__stat-label">failed</div>
            </div>
          </div>

          {taskHistory.length > 0 && (
            <div className="opsdeck-detail__section">
              <div className="opsdeck-detail__label">Task History</div>
              <div className="opsdeck-detail__history">
                {taskHistory.slice().reverse().map((t, i) => (
                  <div key={i} className="opsdeck-detail__history-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className={`opsdeck-detail__history-dot ${t.status === 'completed' ? 'opsdeck-detail__history-dot--ok' : 'opsdeck-detail__history-dot--fail'}`} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title || 'Task'}</span>
                      <span className="opsdeck-timeline__ts">{relativeTime(t.ts)}</span>
                    </div>
                    {t.status === 'completed' && t.result && (
                      <div style={{
                        marginTop: 4, marginLeft: 18, padding: '4px 8px',
                        fontSize: 10, lineHeight: 1.4,
                        color: 'rgba(255,255,255,0.45)',
                        background: 'rgba(255,255,255,0.03)',
                        borderRadius: 4,
                        overflow: 'hidden', textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap', maxWidth: '100%',
                      }}>
                        {String(t.result).slice(0, 200)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="opsdeck-detail__section">
            <div className="opsdeck-detail__label">Live Feed</div>
            <CommandStream events={filteredEvents} maxVisible={8} variant="compact" />
          </div>
        </>
      )}
    </div>
  )
}
