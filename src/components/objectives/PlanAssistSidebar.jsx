/**
 * PlanAssistSidebar — PRISM agent chat for objective plan review & refinement.
 *
 * Injected context: objective title, description, decomposed tasks, team info.
 * Users can ask PRISM to critique, adjust, or explain the plan before approving.
 * Includes an "Apply as Adjustment" action that feeds the conversation back into
 * the reject-plan-with-feedback flow for re-decomposition.
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
import './plan-assist.css'

const SUGGESTIONS = [
  'Are there any risks in this plan?',
  'Should any tasks be reordered?',
  'Are agent assignments optimal?',
  'What dependencies might be missing?',
  'Summarise this plan in one paragraph',
]

export function PlanAssistSidebar({ objective, tasks, teamName, onAdjust, onClose }) {
  const { getSetting } = useSettings()
  const useGlassChat = getSetting('useGlassChat', false)
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const messagesEndRef = useRef(null)
  const clearRef = useRef(null)
  const orgId = currentOrg?.id
  const [lastAssistantMsg, setLastAssistantMsg] = useState('')

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const buildPlanContext = useCallback(async () => {
    const lines = [
      '## Objective Plan Context',
      `- **Objective:** ${objective?.title || 'Untitled'}`,
      `- **Status:** ${objective?.status || 'unknown'}`,
    ]
    if (objective?.description) {
      lines.push(`- **Description:** ${objective.description}`)
    }
    if (teamName) {
      lines.push(`- **Team:** ${teamName}`)
    }
    if (tasks && tasks.length > 0) {
      lines.push('', '### Decomposed Tasks')
      tasks.forEach((t, i) => {
        const deps = t.depends_on ? ` (depends on: ${t.depends_on})` : ''
        lines.push(`${i + 1}. **${t.title}** → agent: \`${t.agent_id}\`${deps}`)
        if (t.prompt) lines.push(`   _${t.prompt.substring(0, 120)}${t.prompt.length > 120 ? '...' : ''}_`)
      })
    }
    lines.push(
      '',
      'You are PRISM, the analysis and classification specialist. The user is reviewing a decomposed objective plan before approving it for execution.',
      'Help them understand the plan, identify risks, suggest improvements, and optimise task ordering and agent assignments.',
      'Be concise and structured. Use bullet points. If suggesting changes, be specific about which tasks to modify and how.',
      'Do NOT execute any tools — this is a review conversation only.'
    )
    return lines.join('\n')
  }, [objective, tasks, teamName])

  return (
    <div className="pas">
      {/* Header */}
      <div className="pas-header">
        <div className="pas-header__agent">
          <span className="pas-header__dot" />
          <span className="pas-header__name">PRISM</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="pas-header__role">Plan Assist</span>
          <SidebarNewChatButton onClick={() => clearRef.current?.()} />
          {onClose && (
            <button onClick={onClose} className="pas-close" aria-label="Close">✕</button>
          )}
        </div>
      </div>

      {/* Objective summary strip */}
      <div className="pas-context-strip">
        <span className="pas-context-label">Reviewing:</span>
        <span className="pas-context-title">{objective?.title || 'Untitled'}</span>
        <span className="pas-context-count">{tasks?.length || 0} tasks</span>
      </div>

      {/* Chat body */}
      <ChatEngine
        agent="prism"
        contextBuilder={buildPlanContext}
        sessionPrefix={`PLAN_ASSIST_${objective?.id || 'new'}`}
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

          // Track last assistant message for "Apply as Adjustment"
          const latestAssistant = messages.filter(m => m.role !== 'user').slice(-1)[0]
          if (latestAssistant && latestAssistant.text !== lastAssistantMsg) {
            setLastAssistantMsg(latestAssistant.text)
          }

          const handleSend = (text) => {
            if (!text || isProcessing) return
            sendMessage(text)
            setTimeout(scrollToBottom, 100)
          }

          const messageList = (
            <>
              {messages.length === 0 && (
                <div className="pas-empty">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(139, 92, 246, 0.5)', marginBottom: 8 }}>
                    <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  <span>Ask PRISM to review this plan...</span>
                  <div className="pas-suggestions">
                    {SUGGESTIONS.map((s, i) => (
                      <button key={i} className="pas-chip" onClick={() => handleSend(s)}>{s}</button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((msg, i) => (
                <div
                  key={msg.messageId || i}
                  className={`pas-msg pas-msg--${msg.role === 'user' ? 'user' : 'assistant'}`}
                >
                  <div className="pas-msg__text">{msg.text}</div>
                </div>
              ))}
              {isProcessing && (
                <div className="pas-msg pas-msg--assistant">
                  <div className="pas-typing"><span /><span /><span /></div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )

          if (useGlassChat) {
            return (
              <>
                <div className="pas-chat-body">
                  <GlassChatPanel
                    variant="compact"
                    agent="prism"
                    halState={halState || 'idle'}
                    isProcessing={isProcessing}
                    onSend={handleSend}
                    onStop={abortMessage}
                    placeholder="Ask PRISM about this plan..."
                    enableVoice={false}
                  >
                    <div className="pas-messages">{messageList}</div>
                  </GlassChatPanel>

                  {/* Apply adjustment action — only when we have conversation and an onAdjust handler */}
                  {onAdjust && messages.length >= 2 && !isProcessing && (
                    <div className="pas-apply-bar">
                      <button
                        className="pas-apply-btn"
                        onClick={() => {
                          const userMsgs = messages.filter(m => m.role === 'user').map(m => m.text)
                          const assistantMsgs = messages.filter(m => m.role !== 'user').map(m => m.text)
                          const feedback = [
                            'User feedback from plan review:',
                            ...userMsgs.map(m => `- ${m}`),
                            '',
                            'PRISM analysis:',
                            assistantMsgs.slice(-1)[0] || ''
                          ].join('\n')
                          onAdjust(feedback)
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
              <div className="pas-viz">
                <VisualizerSection
                  agent="prism"
                  state={halState || 'idle'}
                  showVoice={false}
                  showControls={true}
                  showStatus={false}
                  defaultCollapsed={true}
                  storageKey="plan-assist-viz-collapsed"
                />
              </div>

              <div className="pas-chat-body">
                <div className="pas-messages">{messageList}</div>

                {/* Apply adjustment action — only when we have conversation and an onAdjust handler */}
                {onAdjust && messages.length >= 2 && !isProcessing && (
                  <div className="pas-apply-bar">
                    <button
                      className="pas-apply-btn"
                      onClick={() => {
                        const userMsgs = messages.filter(m => m.role === 'user').map(m => m.text)
                        const assistantMsgs = messages.filter(m => m.role !== 'user').map(m => m.text)
                        const feedback = [
                          'User feedback from plan review:',
                          ...userMsgs.map(m => `- ${m}`),
                          '',
                          'PRISM analysis:',
                          assistantMsgs.slice(-1)[0] || ''
                        ].join('\n')
                        onAdjust(feedback)
                      }}
                    >
                      ↻ Apply as Adjustment & Re-plan
                    </button>
                  </div>
                )}

                <div className="pas-input-wrap">
                  <ChatInput
                    onSend={handleSend}
                    onStop={abortMessage}
                    placeholder="Ask PRISM about this plan..."
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

export default PlanAssistSidebar
