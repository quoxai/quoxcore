/**
 * QuoxCORE Working Set Memory Panel
 *
 * UI for the "RAM" of the user relationship - displays active context,
 * current focus, open loops, recent entities, and decisions.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  getWorkingSet,
  setCurrentFocus,
  clearCurrentFocus,
  getActiveProjects,
  getRecentEntities,
  getOpenLoops,
  resolveOpenLoop,
  touchOpenLoop,
  getRecentDecisions,
  getActivePainPoints,
  resolvePainPoint,
  getSessionContext,
  OPEN_LOOP_STATUS
} from '../../services/workingSetMemory'
import './memory.css'

// Priority colors
const PRIORITY_COLORS = {
  urgent: '#e74c3c',
  high: '#f39c12',
  medium: '#4a9eff',
  low: '#27ae60'
}

// Loop type icons
const LOOP_TYPE_ICONS = {
  question: '?',
  task: '!',
  decision: '*',
  investigation: 'i',
  followup: 'f',
  reminder: 'r'
}

// Entity type icons
const ENTITY_TYPE_ICONS = {
  host: '[]',
  service: '{}',
  person: '@',
  file: '#',
  container: '{}',
  general: '-'
}

/**
 * Working Set Memory Panel
 */
export function WorkingSetMemoryPanel({ onClose }) {
  const [workingSet, setWorkingSet] = useState(null)
  const [activeTab, setActiveTab] = useState('focus')
  const [loading, setLoading] = useState(true)
  const [editingFocus, setEditingFocus] = useState(false)
  const [focusForm, setFocusForm] = useState({ task: '', project: '', goal: '' })

  // Load working set data
  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 5000)
    return () => clearInterval(interval)
  }, [])

  const loadData = useCallback(() => {
    try {
      const ws = getWorkingSet()
      setWorkingSet(ws)
      setLoading(false)
    } catch (err) {
      console.error('Failed to load working set:', err)
      setLoading(false)
    }
  }, [])

  // Handle focus update
  const handleSetFocus = () => {
    if (focusForm.task || focusForm.goal) {
      setCurrentFocus(focusForm)
      setEditingFocus(false)
      setFocusForm({ task: '', project: '', goal: '' })
      loadData()
    }
  }

  // Handle focus clear
  const handleClearFocus = (reason = 'completed') => {
    clearCurrentFocus(reason)
    loadData()
  }

  // Handle loop resolution
  const handleResolveLoop = (loopId, outcome = 'completed') => {
    resolveOpenLoop(loopId, { outcome })
    loadData()
  }

  // Handle loop pause
  const handlePauseLoop = (loopId) => {
    touchOpenLoop(loopId, { status: OPEN_LOOP_STATUS.paused })
    loadData()
  }

  // Handle pain point resolution
  const handleResolvePainPoint = (ppId) => {
    resolvePainPoint(ppId)
    loadData()
  }

  if (loading) {
    return (
      <div className="wsm-panel">
        <div className="wsm-loading">Loading working set...</div>
      </div>
    )
  }

  return (
    <div className="wsm-panel">
      {/* Header */}
      <div className="wsm-header">
        <div className="wsm-title">
          <span className="wsm-icon">RAM</span>
          <h2>Working Set Memory</h2>
        </div>
        <div className="wsm-header-actions">
          <span className="wsm-status-indicator active" />
          <span className="wsm-last-updated">
            Updated: {workingSet?.lastUpdated ? new Date(workingSet.lastUpdated).toLocaleTimeString() : 'Never'}
          </span>
          {onClose && (
            <button className="wsm-close-btn" onClick={onClose}>X</button>
          )}
        </div>
      </div>

      <p className="panel-intro">Your active context: the &apos;RAM&apos; of our relationship. Current focus, open threads, recent entities, and decisions are injected into every AI interaction to keep responses relevant.</p>

      {/* Tab Navigation */}
      <div className="wsm-tabs">
        <button
          className={activeTab === 'focus' ? 'active' : ''}
          onClick={() => setActiveTab('focus')}
        >
          Focus
        </button>
        <button
          className={activeTab === 'loops' ? 'active' : ''}
          onClick={() => setActiveTab('loops')}
        >
          Open Loops
          {getOpenLoops({ limit: 20 }).length > 0 && (
            <span className="wsm-tab-badge">{getOpenLoops({ limit: 20 }).length}</span>
          )}
        </button>
        <button
          className={activeTab === 'entities' ? 'active' : ''}
          onClick={() => setActiveTab('entities')}
        >
          Entities
        </button>
        <button
          className={activeTab === 'decisions' ? 'active' : ''}
          onClick={() => setActiveTab('decisions')}
        >
          Decisions
        </button>
        <button
          className={activeTab === 'session' ? 'active' : ''}
          onClick={() => setActiveTab('session')}
        >
          Session
        </button>
      </div>

      {/* Content */}
      <div className="wsm-content">
        {activeTab === 'focus' && (
          <FocusView
            focus={workingSet?.currentFocus}
            projects={getActiveProjects()}
            painPoints={getActivePainPoints()}
            editingFocus={editingFocus}
            focusForm={focusForm}
            onEditFocus={() => setEditingFocus(true)}
            onCancelEdit={() => setEditingFocus(false)}
            onFocusFormChange={setFocusForm}
            onSetFocus={handleSetFocus}
            onClearFocus={handleClearFocus}
            onResolvePainPoint={handleResolvePainPoint}
          />
        )}

        {activeTab === 'loops' && (
          <OpenLoopsView
            loops={getOpenLoops({ includeResolved: false, limit: 20 })}
            onResolve={handleResolveLoop}
            onPause={handlePauseLoop}
          />
        )}

        {activeTab === 'entities' && (
          <EntitiesView entities={getRecentEntities(null, 20)} />
        )}

        {activeTab === 'decisions' && (
          <DecisionsView decisions={getRecentDecisions(10)} />
        )}

        {activeTab === 'session' && (
          <SessionView session={workingSet?.sessionContext} userState={workingSet?.userState} />
        )}
      </div>
    </div>
  )
}

/**
 * Focus View - Current task and projects
 */
function FocusView({
  focus,
  projects,
  painPoints,
  editingFocus,
  focusForm,
  onEditFocus,
  onCancelEdit,
  onFocusFormChange,
  onSetFocus,
  onClearFocus,
  onResolvePainPoint
}) {
  return (
    <div className="wsm-focus-view">
      {/* Current Focus */}
      <div className="wsm-section">
        <h3>Current Focus</h3>
        {focus?.task ? (
          <div className="wsm-focus-card">
            <div className="wsm-focus-task">{focus.task}</div>
            {focus.goal && (
              <div className="wsm-focus-goal">Goal: {focus.goal}</div>
            )}
            {focus.project && (
              <div className="wsm-focus-project">Project: {focus.project}</div>
            )}
            <div className="wsm-focus-meta">
              Started: {focus.startedAt ? new Date(focus.startedAt).toLocaleTimeString() : 'Unknown'}
            </div>
            <div className="wsm-focus-actions">
              <button className="wsm-btn primary" onClick={() => onClearFocus('completed')}>
                Complete
              </button>
              <button className="wsm-btn" onClick={() => onClearFocus('interrupted')}>
                Pause
              </button>
            </div>
          </div>
        ) : editingFocus ? (
          <div className="wsm-focus-editor">
            <input
              type="text"
              placeholder="What are you working on?"
              value={focusForm.task}
              onChange={(e) => onFocusFormChange({ ...focusForm, task: e.target.value })}
            />
            <input
              type="text"
              placeholder="Goal (optional)"
              value={focusForm.goal}
              onChange={(e) => onFocusFormChange({ ...focusForm, goal: e.target.value })}
            />
            <input
              type="text"
              placeholder="Project (optional)"
              value={focusForm.project}
              onChange={(e) => onFocusFormChange({ ...focusForm, project: e.target.value })}
            />
            <div className="wsm-focus-actions">
              <button className="wsm-btn primary" onClick={onSetFocus}>Set Focus</button>
              <button className="wsm-btn" onClick={onCancelEdit}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="wsm-empty-focus">
            <p>No current focus set</p>
            <button className="wsm-btn primary" onClick={onEditFocus}>Set Focus</button>
          </div>
        )}
      </div>

      {/* Active Projects */}
      <div className="wsm-section">
        <h3>Active Projects</h3>
        {projects.length > 0 ? (
          <div className="wsm-projects-list">
            {projects.map((project) => (
              <div key={project.id} className="wsm-project-item">
                <div className="wsm-project-name">{project.name}</div>
                {project.description && (
                  <div className="wsm-project-desc">{project.description}</div>
                )}
                <div className="wsm-project-meta">
                  <span className={`priority-${project.priority}`}>
                    {project.priority}
                  </span>
                  <span>
                    Last: {new Date(project.lastWorkedOn).toLocaleDateString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="wsm-empty">No active projects</div>
        )}
      </div>

      {/* Pain Points */}
      <div className="wsm-section">
        <h3>Pain Points</h3>
        {painPoints.length > 0 ? (
          <div className="wsm-pain-points-list">
            {painPoints.map((pp) => (
              <div key={pp.id} className={`wsm-pain-point severity-${pp.severity}`}>
                <div className="wsm-pain-point-content">{pp.description}</div>
                <div className="wsm-pain-point-meta">
                  <span className="severity-badge">{pp.severity}</span>
                  <span>Mentioned {pp.mentionCount}x</span>
                  <button
                    className="wsm-btn-small"
                    onClick={() => onResolvePainPoint(pp.id)}
                  >
                    Resolve
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="wsm-empty">No active pain points</div>
        )}
      </div>
    </div>
  )
}

/**
 * Open Loops View - Unresolved threads
 */
function OpenLoopsView({ loops, onResolve, onPause }) {
  return (
    <div className="wsm-loops-view">
      {loops.length > 0 ? (
        <div className="wsm-loops-list">
          {loops.map((loop) => (
            <div
              key={loop.id}
              className={`wsm-loop-card priority-${loop.priority} status-${loop.status}`}
            >
              <div className="wsm-loop-header">
                <span className="wsm-loop-type">
                  [{LOOP_TYPE_ICONS[loop.type] || '-'}] {loop.type}
                </span>
                <span
                  className="wsm-loop-priority"
                  style={{ color: PRIORITY_COLORS[loop.priority] }}
                >
                  {loop.priority}
                </span>
              </div>
              <div className="wsm-loop-description">{loop.description}</div>
              {loop.context?.whereWeLeftOff && (
                <div className="wsm-loop-context">
                  Left off: {loop.context.whereWeLeftOff}
                </div>
              )}
              <div className="wsm-loop-meta">
                <span>Created: {new Date(loop.timeline.createdAt).toLocaleDateString()}</span>
                {loop.timeline.dueBy && (
                  <span className="wsm-loop-due">
                    Due: {new Date(loop.timeline.dueBy).toLocaleDateString()}
                  </span>
                )}
              </div>
              <div className="wsm-loop-actions">
                <button
                  className="wsm-btn primary"
                  onClick={() => onResolve(loop.id, 'completed')}
                >
                  Resolve
                </button>
                {loop.status !== OPEN_LOOP_STATUS.paused && (
                  <button className="wsm-btn" onClick={() => onPause(loop.id)}>
                    Pause
                  </button>
                )}
                <button
                  className="wsm-btn danger"
                  onClick={() => onResolve(loop.id, 'abandoned')}
                >
                  Abandon
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="wsm-empty-state">
          <div className="wsm-empty-icon">OK</div>
          <p>No open loops - all threads resolved</p>
        </div>
      )}
    </div>
  )
}

/**
 * Entities View - Recently referenced entities
 */
function EntitiesView({ entities }) {
  return (
    <div className="wsm-entities-view">
      {entities.length > 0 ? (
        <div className="wsm-entities-list">
          {entities.map((entity, idx) => (
            <div key={`${entity.type}-${entity.id}-${idx}`} className="wsm-entity-item">
              <span className="wsm-entity-icon">
                {ENTITY_TYPE_ICONS[entity.type] || ENTITY_TYPE_ICONS.general}
              </span>
              <div className="wsm-entity-info">
                <div className="wsm-entity-name">{entity.name}</div>
                <div className="wsm-entity-type">{entity.type}</div>
              </div>
              <div className="wsm-entity-stats">
                <span className="wsm-entity-count">{entity.mentionCount}x</span>
                <span className="wsm-entity-time">
                  {new Date(entity.lastMentioned).toLocaleTimeString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="wsm-empty">No recent entities</div>
      )}
    </div>
  )
}

/**
 * Decisions View - Recent decisions with rationale
 */
function DecisionsView({ decisions }) {
  return (
    <div className="wsm-decisions-view">
      {decisions.length > 0 ? (
        <div className="wsm-decisions-list">
          {decisions.map((decision) => (
            <div key={decision.id} className="wsm-decision-card">
              <div className="wsm-decision-content">{decision.decision}</div>
              {decision.rationale && (
                <div className="wsm-decision-rationale">
                  Rationale: {decision.rationale}
                </div>
              )}
              {decision.alternatives && decision.alternatives.length > 0 && (
                <div className="wsm-decision-alternatives">
                  Alternatives: {decision.alternatives.join(', ')}
                </div>
              )}
              <div className="wsm-decision-meta">
                <span>{new Date(decision.madeAt).toLocaleDateString()}</span>
                {decision.relatedProject && (
                  <span>Project: {decision.relatedProject}</span>
                )}
                <span className={decision.reversible ? 'reversible' : 'irreversible'}>
                  {decision.reversible ? 'Reversible' : 'Irreversible'}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="wsm-empty">No recent decisions</div>
      )}
    </div>
  )
}

/**
 * Session View - Current session context
 */
function SessionView({ session, userState }) {
  return (
    <div className="wsm-session-view">
      {/* Session Info */}
      <div className="wsm-section">
        <h3>Session Context</h3>
        {session?.sessionId ? (
          <div className="wsm-session-info">
            <div className="wsm-session-stat">
              <span className="wsm-stat-label">Session ID</span>
              <span className="wsm-stat-value">{session.sessionId.slice(0, 16)}...</span>
            </div>
            <div className="wsm-session-stat">
              <span className="wsm-stat-label">Started</span>
              <span className="wsm-stat-value">
                {session.startedAt ? new Date(session.startedAt).toLocaleTimeString() : 'Unknown'}
              </span>
            </div>
            <div className="wsm-session-stat">
              <span className="wsm-stat-label">Messages</span>
              <span className="wsm-stat-value">{session.messageCount || 0}</span>
            </div>
          </div>
        ) : (
          <div className="wsm-empty">No active session</div>
        )}
      </div>

      {/* Topics Discussed */}
      {session?.topicsDiscussed?.length > 0 && (
        <div className="wsm-section">
          <h3>Topics Discussed</h3>
          <div className="wsm-topics-list">
            {session.topicsDiscussed.map((topic, idx) => (
              <span key={idx} className="wsm-topic-tag">{topic}</span>
            ))}
          </div>
        </div>
      )}

      {/* User State */}
      <div className="wsm-section">
        <h3>Inferred User State</h3>
        {userState ? (
          <div className="wsm-user-state">
            <div className="wsm-state-item">
              <span className="wsm-state-label">Mood</span>
              <span className={`wsm-state-value mood-${userState.apparentMood}`}>
                {userState.apparentMood}
              </span>
            </div>
            <div className="wsm-state-item">
              <span className="wsm-state-label">Engagement</span>
              <span className={`wsm-state-value engagement-${userState.engagementLevel}`}>
                {userState.engagementLevel}
              </span>
            </div>
            {userState.lastInferred && (
              <div className="wsm-state-item">
                <span className="wsm-state-label">Last Updated</span>
                <span className="wsm-state-value">
                  {new Date(userState.lastInferred).toLocaleTimeString()}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="wsm-empty">No user state inferred</div>
        )}
      </div>

      {/* Questions Asked */}
      {session?.questionsAsked?.length > 0 && (
        <div className="wsm-section">
          <h3>Questions This Session</h3>
          <div className="wsm-questions-list">
            {session.questionsAsked.slice(-5).map((q, idx) => (
              <div key={idx} className="wsm-question-item">
                <span className="wsm-question-text">{q.question}</span>
                <span className="wsm-question-time">
                  {new Date(q.askedAt).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default WorkingSetMemoryPanel
