/**
 * PrismSidebar — Persistent, context-aware PRISM agent chat sidebar.
 *
 * Lives on every teams/objectives page (like DAEDALUS on NOC, WARDEN on SOC).
 * Adapts suggestions and context injection based on what the user is viewing.
 *
 * Modes:
 *   - teams-overview: browsing team cards
 *   - team-detail: inside a specific team (any tab)
 *   - objectives: browsing/viewing objectives
 *
 * Props:
 *   context  — { mode, teams?, team?, objectives?, selectedObjective?, activeTab?, teamName? }
 *   onAction — optional callback for sidebar-initiated actions (e.g. "Apply as Adjustment")
 */

import { useState, useRef, useCallback } from 'react'
import { ChatEngine } from '../chat/ChatEngine'
import { VisualizerSection } from '../chat/sidebar/VisualizerSection'
import SidebarNewChatButton from '../chat/sidebar/SidebarNewChatButton'
import { ChatInput } from '../chat/input/ChatInput'
import { GlassChatPanel } from '../chat/glass'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { useSettings } from '../../hooks/useSettings'
import './prism-sidebar.css'

// ── Context-dependent suggestion chips ──

const SUGGESTIONS = {
  'teams-overview': [
    'Which team should handle a deployment task?',
    'Compare team capabilities',
    'What teams are available?',
    'Suggest a new team composition',
    'Which team has the most agents?',
  ],
  'team-detail': {
    overview: [
      'What are this team\'s strengths?',
      'Suggest an objective for this team',
      'Are there capability gaps?',
      'How should I use this team?',
      'Which agents overlap in skills?',
    ],
    objectives: [
      'What objectives are running?',
      'Why did the last objective fail?',
      'Suggest a new objective',
      'Review the current plan',
      'How can I improve task success rate?',
    ],
    schedules: [
      'What\'s scheduled this week?',
      'Suggest a recurring schedule',
      'Are any schedules overlapping?',
      'What cron expression means "daily at 9am"?',
    ],
    context: [
      'What context should this team have?',
      'Help me write team context',
      'What context improves decomposition?',
    ],
    settings: [
      'What policies should I enable?',
      'When should I require approval?',
      'Explain checkpoint after each task',
      'What does VOLT audit trail do?',
    ],
  },
  objectives: {
    none: [
      'What objectives are failing?',
      'Show a summary of recent runs',
      'Help me create a new objective',
      'What should I run next?',
      'Explain objective statuses',
    ],
    pending: [
      'Help me improve this objective description',
      'What team should run this?',
      'Is this objective well-defined?',
      'Suggest a better title',
    ],
    decomposed: [
      'Review this plan',
      'Are agent assignments optimal?',
      'Should any tasks be reordered?',
      'What risks do you see?',
      'Are there missing dependencies?',
    ],
    running: [
      'What\'s the progress?',
      'Are there any blockers?',
      'Which tasks are taking longest?',
      'Should I pause this?',
    ],
    completed: [
      'Summarise the results',
      'Were there any issues?',
      'Should I run this again?',
      'What did the agents produce?',
    ],
    failed: [
      'Why did this fail?',
      'Which task failed and why?',
      'Can you suggest a fix?',
      'Should I retry or skip the failed task?',
      'Help me adjust the plan',
    ],
    paused: [
      'Why was this paused?',
      'Should I resume or cancel?',
      'What was the last completed task?',
    ],
  },
}

function getSuggestions(context) {
  const { mode, selectedObjective, activeTab } = context || {}

  if (mode === 'teams-overview') {
    return SUGGESTIONS['teams-overview']
  }

  if (mode === 'team-detail') {
    const tab = activeTab || 'overview'
    return SUGGESTIONS['team-detail'][tab] || SUGGESTIONS['team-detail'].overview
  }

  if (mode === 'objectives') {
    if (!selectedObjective) return SUGGESTIONS.objectives.none
    const status = selectedObjective.status || 'pending'
    // Map compound statuses
    if (status === 'completed_with_errors') return SUGGESTIONS.objectives.completed
    if (status === 'decomposing') return SUGGESTIONS.objectives.pending
    if (status === 'cancelled') return SUGGESTIONS.objectives.failed
    return SUGGESTIONS.objectives[status] || SUGGESTIONS.objectives.none
  }

  return SUGGESTIONS['teams-overview']
}

// ── Context string builder ──

function buildTeamsOverviewContext(context) {
  const lines = [
    '## Teams Overview Context',
    `The user is browsing the Agentic Teams overview page.`,
  ]
  if (context.teams && context.teams.length > 0) {
    lines.push('', `### Available Teams (${context.teams.length})`)
    context.teams.forEach(t => {
      const agents = t.agentCount || 0
      const status = t.status || 'unknown'
      lines.push(`- **${t.displayName}** — ${agents} agents, status: ${status}${t.description ? ` — ${t.description.substring(0, 100)}` : ''}`)
    })
  }
  return lines
}

function buildTeamDetailContext(context) {
  const { team, objectives, activeTab } = context
  const lines = [
    '## Team Detail Context',
    `- **Team:** ${team?.displayName || team?.id || 'Unknown'}`,
    `- **Active Tab:** ${activeTab || 'overview'}`,
    `- **Status:** ${team?.status || 'unknown'}`,
  ]
  if (team?.description) {
    lines.push(`- **Description:** ${team.description}`)
  }
  if (team?.manifest) {
    const m = team.manifest
    if (m.orchestrator) {
      lines.push(`- **Orchestrator:** ${m.orchestrator.agentId}`)
    }
    if (m.members && m.members.length > 0) {
      lines.push('', '### Team Members')
      m.members.forEach(member => {
        const domains = member.domains?.length > 0 ? ` (${member.domains.join(', ')})` : ''
        lines.push(`- **${member.agentId}** — role: ${member.role}${domains}`)
      })
    }
    if (m.policies) {
      lines.push('', '### Policies')
      Object.entries(m.policies).forEach(([k, v]) => {
        lines.push(`- ${k}: ${v}`)
      })
    }
  }
  if (objectives && objectives.length > 0) {
    lines.push('', `### Recent Objectives (${objectives.length})`)
    objectives.slice(0, 8).forEach(o => {
      const progress = o.task_count ? `${o.tasks_completed || 0}/${o.task_count}` : 'n/a'
      lines.push(`- **${o.title}** — status: ${o.status}, progress: ${progress}`)
    })
  }
  return lines
}

function buildObjectivesContext(context) {
  const { selectedObjective, objectives } = context
  const lines = [
    '## Objectives Context',
    `The user is on the Objectives management page.`,
  ]
  if (objectives && objectives.length > 0) {
    const running = objectives.filter(o => o.status === 'running').length
    const failed = objectives.filter(o => o.status === 'failed').length
    const completed = objectives.filter(o => o.status === 'completed').length
    lines.push(`- **Total:** ${objectives.length} objectives (${running} running, ${completed} completed, ${failed} failed)`)
  }
  if (selectedObjective) {
    const obj = selectedObjective
    lines.push('', '### Selected Objective')
    lines.push(`- **Title:** ${obj.title}`)
    lines.push(`- **Status:** ${obj.status}`)
    if (obj.description) lines.push(`- **Description:** ${obj.description}`)
    if (obj.team_id) lines.push(`- **Team:** ${context.teamName || obj.team_id}`)
    const progress = obj.task_count ? `${obj.tasks_completed || 0}/${obj.task_count} tasks` : 'no tasks'
    lines.push(`- **Progress:** ${progress}`)
    if (obj.tasks_failed > 0) lines.push(`- **Failed tasks:** ${obj.tasks_failed}`)

    if (obj.tasks && obj.tasks.length > 0) {
      lines.push('', '### Tasks')
      obj.tasks.forEach((t, i) => {
        const deps = t.depends_on ? ` (depends on: ${t.depends_on})` : ''
        const status = t.status || 'pending'
        lines.push(`${i + 1}. **${t.title}** → agent: \`${t.agent_id}\`, status: ${status}${deps}`)
        if (t.prompt) lines.push(`   _${t.prompt.substring(0, 120)}${t.prompt.length > 120 ? '...' : ''}_`)
        if (t.result && status === 'failed') {
          const errSnippet = typeof t.result === 'string' ? t.result.substring(0, 200) : JSON.stringify(t.result).substring(0, 200)
          lines.push(`   **Error:** ${errSnippet}`)
        }
        if (t.result && status === 'completed') {
          const resSnippet = typeof t.result === 'string' ? t.result.substring(0, 150) : JSON.stringify(t.result).substring(0, 150)
          lines.push(`   Result: ${resSnippet}...`)
        }
      })
    }
  }
  return lines
}

// ── Main component ──

export function PrismSidebar({ context, onAction }) {
  const { getSetting } = useSettings()
  const useGlassChat = getSetting('useGlassChat', false)
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const messagesEndRef = useRef(null)
  const clearRef = useRef(null)
  const orgId = currentOrg?.id

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const suggestions = getSuggestions(context)

  const buildContext = useCallback(async () => {
    let contextLines = []
    const mode = context?.mode || 'teams-overview'

    if (mode === 'teams-overview') {
      contextLines = buildTeamsOverviewContext(context)
    } else if (mode === 'team-detail') {
      contextLines = buildTeamDetailContext(context)
    } else if (mode === 'objectives') {
      contextLines = buildObjectivesContext(context)
    }

    contextLines.push(
      '',
      'You are PRISM, the analysis and planning specialist. You assist with agentic teams, objectives, and workflows.',
      'You help users understand their teams, review and improve objective plans, diagnose failures, suggest improvements, and answer questions about the system.',
      'Be concise and structured. Use bullet points. When suggesting changes, be specific.',
      'If the user asks about failures, analyse the task results and error messages in context.',
      'If the user asks to create or improve an objective, help them write a clear title and description.',
      'Do NOT execute any tools — this is an advisory conversation only.',
    )
    return contextLines.join('\n')
  }, [context])

  // Session prefix changes with context so chat resets when navigating
  const sessionPrefix = context?.mode === 'team-detail'
    ? `PRISM_TEAM_${context.team?.id || 'unknown'}`
    : context?.mode === 'objectives' && context?.selectedObjective
      ? `PRISM_OBJ_${context.selectedObjective.id}`
      : context?.mode === 'objectives'
        ? 'PRISM_OBJECTIVES'
        : 'PRISM_TEAMS'

  return (
    <div className="psc">
      <ChatEngine
        agent="prism"
        contextBuilder={buildContext}
        sessionPrefix={sessionPrefix}
        surface="sidebar"
        enableSmartRouter={false}
        enableMemory={true}
        authFetch={authFetch}
        orgId={orgId}
        enablePersistence={!!orgId}
      >
        {(chatState) => {
          const { messages, isProcessing, halState, sendMessage, abortMessage, clearConversation } = chatState
          clearRef.current = clearConversation

          const handleSend = (text) => {
            if (!text || isProcessing) return
            sendMessage(text)
            setTimeout(scrollToBottom, 100)
          }

          const messageList = (
            <>
              {messages.length === 0 && (
                <div className="psc-empty">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(139, 92, 246, 0.5)', marginBottom: 8 }}>
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                  <span>Ask PRISM anything...</span>
                  <div className="psc-suggestions">
                    {suggestions.map((s, i) => (
                      <button key={i} className="psc-chip" onClick={() => handleSend(s)}>{s}</button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((msg, i) => (
                <div
                  key={msg.messageId || i}
                  className={`psc-msg psc-msg--${msg.role === 'user' ? 'user' : 'assistant'}`}
                >
                  <div className="psc-msg__text">{msg.text}</div>
                </div>
              ))}
              {isProcessing && (
                <div className="psc-msg psc-msg--assistant">
                  <div className="psc-typing"><span /><span /><span /></div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )

          if (useGlassChat) {
            return (
              <>
                {/* Header */}
                <div className="psc-header">
                  <div className="psc-header__agent">
                    <span className="psc-header__dot" />
                    <span className="psc-header__name">PRISM</span>
                  </div>
                  <span className="psc-header__role">
                    {context?.mode === 'teams-overview' ? 'Teams Assist' :
                     context?.mode === 'team-detail' ? 'Team Assist' :
                     'Objectives Assist'}
                  </span>
                  <SidebarNewChatButton onClick={() => clearRef.current?.()} />
                </div>

                {/* Context strip */}
                <div className="psc-context-strip">
                  {context?.mode === 'teams-overview' && (
                    <>
                      <span className="psc-context-label">Browsing:</span>
                      <span className="psc-context-title">All Teams</span>
                      <span className="psc-context-count">{context.teams?.length || 0} teams</span>
                    </>
                  )}
                  {context?.mode === 'team-detail' && (
                    <>
                      <span className="psc-context-label">Team:</span>
                      <span className="psc-context-title">{context.team?.displayName || context.team?.id || '—'}</span>
                      <span className="psc-context-count">{context.activeTab || 'overview'}</span>
                    </>
                  )}
                  {context?.mode === 'objectives' && (
                    <>
                      <span className="psc-context-label">{context.selectedObjective ? 'Viewing:' : 'Browsing:'}</span>
                      <span className="psc-context-title">
                        {context.selectedObjective?.title || 'Objectives'}
                      </span>
                      {context.selectedObjective && (
                        <span className={`psc-context-status psc-context-status--${context.selectedObjective.status}`}>
                          {context.selectedObjective.status}
                        </span>
                      )}
                    </>
                  )}
                </div>

                {/* Chat body */}
                <div className="psc-chat-body">
                  <GlassChatPanel
                    variant="compact"
                    agent="prism"
                    halState={halState || 'idle'}
                    isProcessing={isProcessing}
                    onSend={handleSend}
                    onStop={abortMessage}
                    placeholder="Ask PRISM..."
                    enableVoice={false}
                  >
                    <div className="psc-messages">{messageList}</div>
                  </GlassChatPanel>

                  {/* Action bar for decomposed objectives */}
                  {onAction && context?.selectedObjective?.status === 'decomposed' && messages.length >= 2 && !isProcessing && (
                    <div className="psc-action-bar">
                      <button
                        className="psc-action-btn"
                        onClick={async () => {
                          const userMsgs = messages.filter(m => m.role === 'user').map(m => m.text)
                          const assistantMsgs = messages.filter(m => m.role !== 'user').map(m => m.text)
                          const feedback = [
                            'User feedback from PRISM plan review:',
                            ...userMsgs.map(m => `- ${m}`),
                            '',
                            'PRISM analysis:',
                            assistantMsgs.slice(-1)[0] || ''
                          ].join('\n')
                          try {
                            await onAction(feedback)
                          } catch (err) {
                            console.error('[PrismSidebar] Apply adjustment failed:', err)
                          }
                        }}
                      >
                        ↻ Apply as Adjustment & Re-plan
                      </button>
                    </div>
                  )}
                </div>
              </>
            )
          }

          return (
            <>
              {/* Header */}
              <div className="psc-header">
                <div className="psc-header__agent">
                  <span className="psc-header__dot" />
                  <span className="psc-header__name">PRISM</span>
                </div>
                <span className="psc-header__role">
                  {context?.mode === 'teams-overview' ? 'Teams Assist' :
                   context?.mode === 'team-detail' ? 'Team Assist' :
                   'Objectives Assist'}
                </span>
                <SidebarNewChatButton onClick={() => clearRef.current?.()} />
              </div>

              {/* Context strip */}
              <div className="psc-context-strip">
                {context?.mode === 'teams-overview' && (
                  <>
                    <span className="psc-context-label">Browsing:</span>
                    <span className="psc-context-title">All Teams</span>
                    <span className="psc-context-count">{context.teams?.length || 0} teams</span>
                  </>
                )}
                {context?.mode === 'team-detail' && (
                  <>
                    <span className="psc-context-label">Team:</span>
                    <span className="psc-context-title">{context.team?.displayName || context.team?.id || '—'}</span>
                    <span className="psc-context-count">{context.activeTab || 'overview'}</span>
                  </>
                )}
                {context?.mode === 'objectives' && (
                  <>
                    <span className="psc-context-label">{context.selectedObjective ? 'Viewing:' : 'Browsing:'}</span>
                    <span className="psc-context-title">
                      {context.selectedObjective?.title || 'Objectives'}
                    </span>
                    {context.selectedObjective && (
                      <span className={`psc-context-status psc-context-status--${context.selectedObjective.status}`}>
                        {context.selectedObjective.status}
                      </span>
                    )}
                  </>
                )}
              </div>

              {/* Visualizer */}
              <div className="psc-viz">
                <VisualizerSection
                  agent="prism"
                  state={halState || 'idle'}
                  showVoice={false}
                  showControls={true}
                  showStatus={false}
                  defaultCollapsed={true}
                  storageKey="prism-sidebar-viz-collapsed"
                />
              </div>

              {/* Chat body */}
              <div className="psc-chat-body">
                <div className="psc-messages">{messageList}</div>

                {/* Action bar for decomposed objectives */}
                {onAction && context?.selectedObjective?.status === 'decomposed' && messages.length >= 2 && !isProcessing && (
                  <div className="psc-action-bar">
                    <button
                      className="psc-action-btn"
                      onClick={async () => {
                        const userMsgs = messages.filter(m => m.role === 'user').map(m => m.text)
                        const assistantMsgs = messages.filter(m => m.role !== 'user').map(m => m.text)
                        const feedback = [
                          'User feedback from PRISM plan review:',
                          ...userMsgs.map(m => `- ${m}`),
                          '',
                          'PRISM analysis:',
                          assistantMsgs.slice(-1)[0] || ''
                        ].join('\n')
                        try {
                          await onAction(feedback)
                        } catch (err) {
                          console.error('[PrismSidebar] Apply adjustment failed:', err)
                        }
                      }}
                    >
                      ↻ Apply as Adjustment & Re-plan
                    </button>
                  </div>
                )}

                <div className="psc-input-wrap">
                  <ChatInput
                    onSend={handleSend}
                    onStop={abortMessage}
                    placeholder="Ask PRISM..."
                    isProcessing={isProcessing}
                    enableVoice={false}
                    enableFileUpload={false}
                    hints={false}
                    maxRows={3}
                  />
                </div>
              </div>
            </>
          )
        }}
      </ChatEngine>
    </div>
  )
}

export default PrismSidebar
