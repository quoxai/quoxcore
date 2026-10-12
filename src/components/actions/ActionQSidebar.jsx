/**
 * ActionQSidebar — Persistent ACTION-Q agent chat sidebar for ActionsView.
 *
 * Follows the PrismSidebar pattern: context-aware chat with suggestion chips,
 * collapsible with localStorage persistence.
 *
 * Props:
 *   actions  — { items: [], streak: { current, lastCompletionDate } }
 *   stats    — { total, pct, doneThisWeek, overdue, avgDays } from computeStats
 */

import { useRef, useCallback } from 'react'
import { ChatEngine } from '../chat/ChatEngine'
import { VisualizerSection } from '../chat/sidebar/VisualizerSection'
import SidebarNewChatButton from '../chat/sidebar/SidebarNewChatButton'
import { ChatInput } from '../chat/input/ChatInput'
import { GlassChatPanel } from '../chat/glass'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { useSettings } from '../../hooks/useSettings'
import './action-q-sidebar.css'

// ── Suggestion chips ──

const SUGGESTIONS = [
  'Analyse my board',
  'What should I focus on?',
  'Add a new task',
  'Show overdue items',
  'Delegate infrastructure tasks',
  'Summarise my board',
]

// ── Context builder ──

function buildActionContext(actions, stats) {
  const items = actions?.items || []
  const streak = actions?.streak || { current: 0 }

  const todo = items.filter(i => i.status === 'todo')
  const doing = items.filter(i => i.status === 'doing')
  const done = items.filter(i => i.status === 'done')
  const todayStr = new Date().toISOString().slice(0, 10)
  const overdue = items.filter(i => i.dueDate && i.dueDate < todayStr && i.status !== 'done')
  const highPriority = items.filter(i => (i.priority === 'urgent' || i.priority === 'high') && i.status !== 'done')

  const lines = [
    '## Action Board Context',
    `The user is viewing their Action Tracker kanban board.`,
    '',
    '### Board Summary',
    `- **TODO:** ${todo.length} items`,
    `- **DOING:** ${doing.length} items`,
    `- **DONE:** ${done.length} items`,
    `- **Total:** ${stats?.total || items.length} items`,
    `- **Completion:** ${stats?.pct || 0}%`,
    `- **Streak:** ${streak.current} day(s)`,
    `- **Done this week:** ${stats?.doneThisWeek || 0}`,
    `- **Overdue:** ${overdue.length}`,
  ]

  if (overdue.length > 0) {
    lines.push('', '### Overdue Items')
    overdue.slice(0, 8).forEach(item => {
      lines.push(`- **${item.title}** — due: ${item.dueDate}, priority: ${item.priority || 'none'}`)
    })
  }

  if (highPriority.length > 0) {
    lines.push('', '### High Priority Items')
    highPriority.slice(0, 8).forEach(item => {
      lines.push(`- **${item.title}** — status: ${item.status}, priority: ${item.priority}${item.dueDate ? `, due: ${item.dueDate}` : ''}`)
    })
  }

  if (doing.length > 0) {
    lines.push('', '### Currently In Progress')
    doing.slice(0, 5).forEach(item => {
      lines.push(`- **${item.title}**${item.dueDate ? ` — due: ${item.dueDate}` : ''}`)
    })
  }

  // Identify delegated items (items with delegation metadata in description)
  const delegatedItems = items.filter(i =>
    (i.description || '').includes('[delegation_meta]') ||
    (i.notes || '').includes('Delegated to objective')
  )
  if (delegatedItems.length > 0) {
    lines.push('', '### Delegated to Objectives')
    delegatedItems.slice(0, 5).forEach(item => {
      const metaMatch = (item.description || '').match(/\[delegation_meta\](.*?)\[\/delegation_meta\]/)
      let objId = 'unknown'
      if (metaMatch) {
        try { objId = JSON.parse(metaMatch[1]).delegated_objective_id || objId } catch {}
      }
      lines.push(`- **${item.title}** — objective: ${objId.slice(0, 12)}...`)
    })
  }

  // Identify items that could be delegated (infrastructure/security keywords)
  const delegatableKeywords = ['security', 'infrastructure', 'server', 'deploy', 'docker', 'monitor', 'backup', 'firewall', 'ssl', 'nginx']
  const delegatable = todo.filter(i => {
    const text = `${i.title} ${i.description || ''}`.toLowerCase()
    return delegatableKeywords.some(kw => text.includes(kw))
  })
  if (delegatable.length > 0) {
    lines.push('', `### Delegatable Items (${delegatable.length})`)
    lines.push('These items match infrastructure/security patterns and could be delegated to agent teams:')
    delegatable.slice(0, 5).forEach(item => {
      lines.push(`- **${item.title}** (id: ${item.id})`)
    })
  }

  lines.push(
    '',
    'You are ACTION-Q, the task management specialist. Help the user stay organised with their action items.',
    'Use your tools to check the board state before giving advice. Be encouraging about progress.',
    'When suggesting priorities, consider due dates and urgency.',
    'Use action_analyse to provide data-driven insights about the board.',
    'Use action_delegate to hand off infrastructure/security/monitoring tasks to agentic objectives in OpsDeck.',
  )

  return lines.join('\n')
}

// ── Main component ──

export function ActionQSidebar({ actions, stats }) {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const { getSetting } = useSettings()
  const useGlassChat = getSetting('useGlassChat', false)
  const messagesEndRef = useRef(null)
  const clearRef = useRef(null)
  const orgId = currentOrg?.id

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const buildContext = useCallback(async () => {
    return buildActionContext(actions, stats)
  }, [actions, stats])

  return (
    <div className="aqs">
      <ChatEngine
        agent="action-q"
        contextBuilder={buildContext}
        sessionPrefix="ACTION_Q_BOARD"
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
                <div className="aqs-empty">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(245, 158, 11, 0.5)', marginBottom: 8 }}>
                    <polyline points="9 11 12 14 22 4" />
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                  </svg>
                  <span>Ask ACTION-Q anything...</span>
                  <div className="aqs-suggestions">
                    {SUGGESTIONS.map((s, i) => (
                      <button key={i} className="aqs-chip" onClick={() => handleSend(s)}>{s}</button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((msg, i) => (
                <div
                  key={msg.messageId || i}
                  className={`aqs-msg aqs-msg--${msg.role === 'user' ? 'user' : 'assistant'}`}
                >
                  <div className="aqs-msg__text">{msg.text}</div>
                </div>
              ))}
              {isProcessing && (
                <div className="aqs-msg aqs-msg--assistant">
                  <div className="aqs-typing"><span /><span /><span /></div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )

          if (useGlassChat) {
            return (
              <>
                {/* Header */}
                <div className="aqs-header">
                  <div className="aqs-header__agent">
                    <span className="aqs-header__dot" />
                    <span className="aqs-header__name">ACTION-Q</span>
                  </div>
                  <span className="aqs-header__role">Task Assist</span>
                  <SidebarNewChatButton onClick={() => clearRef.current?.()} />
                </div>

                {/* Context strip */}
                <div className="aqs-context-strip">
                  <span className="aqs-context-label">Board:</span>
                  <span className="aqs-context-title">
                    {stats?.total || 0} items
                  </span>
                  {(stats?.overdue || 0) > 0 && (
                    <span className="aqs-context-overdue">
                      {stats.overdue} overdue
                    </span>
                  )}
                  <span className="aqs-context-streak">
                    {'\uD83D\uDD25'} {actions?.streak?.current || 0}
                  </span>
                </div>

                <div className="aqs-chat-body">
                  <GlassChatPanel
                    variant="compact"
                    agent="action-q"
                    halState={halState || 'idle'}
                    isProcessing={isProcessing}
                    onSend={handleSend}
                    onStop={abortMessage}
                    placeholder="Ask ACTION-Q..."
                    enableVoice={false}
                  >
                    <div className="aqs-messages">{messageList}</div>
                  </GlassChatPanel>
                </div>
              </>
            )
          }

          return (
            <>
              {/* Header */}
              <div className="aqs-header">
                <div className="aqs-header__agent">
                  <span className="aqs-header__dot" />
                  <span className="aqs-header__name">ACTION-Q</span>
                </div>
                <span className="aqs-header__role">Task Assist</span>
                <SidebarNewChatButton onClick={() => clearRef.current?.()} />
              </div>

              {/* Context strip */}
              <div className="aqs-context-strip">
                <span className="aqs-context-label">Board:</span>
                <span className="aqs-context-title">
                  {stats?.total || 0} items
                </span>
                {(stats?.overdue || 0) > 0 && (
                  <span className="aqs-context-overdue">
                    {stats.overdue} overdue
                  </span>
                )}
                <span className="aqs-context-streak">
                  {'\uD83D\uDD25'} {actions?.streak?.current || 0}
                </span>
              </div>

              {/* Visualizer */}
              <div className="aqs-viz">
                <VisualizerSection
                  agent="action-q"
                  state={halState || 'idle'}
                  showVoice={false}
                  showControls={true}
                  showStatus={false}
                  defaultCollapsed={true}
                  storageKey="action-q-sidebar-viz-collapsed"
                />
              </div>

              {/* Chat body */}
              <div className="aqs-chat-body">
                <div className="aqs-messages">{messageList}</div>

                <div className="aqs-input-wrap">
                  <ChatInput
                    onSend={handleSend}
                    onStop={abortMessage}
                    placeholder="Ask ACTION-Q..."
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

export default ActionQSidebar
