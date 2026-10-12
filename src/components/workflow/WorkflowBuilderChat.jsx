/**
 * WorkflowBuilderChat — AI chat panel powered by WEAVER via ChatEngine.
 *
 * Uses the existing ChatEngine render-prop pattern to route messages
 * through the collector pipeline as WEAVER (Workflow Design specialist).
 * Parses structured quoxflow-action blocks from responses to mutate workflow state.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChatEngine } from '../chat/ChatEngine'
import { SuggestionChips } from './SuggestionChips'
import { getSystemPromptWithLibrary } from '../../services/workflowBuilderPrompt'
import { parseActions, executeActions, buildWorkflowContext } from '../../services/workflowActions'
import { preloadAgentTools, getAgentTools } from '../../services/agentToolCatalogClient'
import { agentRegistry } from '../../config/agentRegistry'

// Workflow management tools that conflict with the live-canvas action protocol.
// These exist for the saved-workflows registry; on this surface they bypass the
// canvas the user is editing.
const WORKFLOW_BUILDER_TOOL_DENYLIST = [
  'create_workflow',
  'list_workflows',
  'get_workflow',
  'update_workflow',
  'delete_workflow',
  'execute_workflow',
  'activate_workflow',
  'deactivate_workflow',
  'import_n8n_workflow',
  'deploy_template',
  'validate_workflow',
  'save_as_workflow',
]

// Markdown rendering config
const mdComponents = {
  p: ({ children }) => <p className="wb-md-p">{children}</p>,
  strong: ({ children }) => <strong className="wb-md-bold">{children}</strong>,
  code: ({ inline, children }) => inline
    ? <code className="wb-md-code">{children}</code>
    : <pre className="wb-md-pre"><code>{children}</code></pre>,
  ul: ({ children }) => <ul className="wb-md-list">{children}</ul>,
  ol: ({ children }) => <ol className="wb-md-list wb-md-ol">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
}

function ActionBadge({ actionResult }) {
  // Not yet processed — render nothing
  if (!actionResult) return null

  const { applied = 0, errors = [] } = actionResult
  const hasErrors = errors.length > 0

  // No actions emitted at all (plan-phase response) — muted low-key note
  if (applied === 0 && !hasErrors) {
    return (
      <div className="wb-action-badge wb-action-badge--muted">
        no canvas actions emitted
      </div>
    )
  }

  // All errors, nothing applied — red badge with first error
  if (applied === 0 && hasErrors) {
    return (
      <div className="wb-action-badge wb-action-badge--error">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        {errors.length} action error{errors.length > 1 ? 's' : ''} — {errors[0]}
      </div>
    )
  }

  // Some applied, some failed — amber warning badge
  if (applied > 0 && hasErrors) {
    return (
      <div className="wb-action-badge wb-action-badge--warn">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        {applied} applied, {errors.length} failed — {errors[0]}
      </div>
    )
  }

  // All applied, no errors — green success badge
  return (
    <div className="wb-action-badge">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      {applied} action{applied > 1 ? 's' : ''} applied
    </div>
  )
}

function ChatMessage({ message, assistantConfig, actionResult }) {
  const isUser = message.role === 'user'
  const shortName = assistantConfig?.shortName || 'W' // WEAVER (this panel is WEAVER; 'N' was a stale NOVA fallback)
  const agentColor = assistantConfig?.color || '#30ff90'

  // Strip quoxflow-action blocks from display
  const displayContent = isUser
    ? message.text
    : (message.text || '').replace(/```quoxflow-action\s*\n[\s\S]*?```/g, '').trim()

  if (!displayContent) return null

  return (
    <div className={`wb-msg ${isUser ? 'wb-msg--user' : 'wb-msg--ai'}`}>
      {!isUser && (
        <div className="wb-msg__avatar" style={{ borderColor: `${agentColor}33`, background: `${agentColor}15` }}>
          <span style={{ color: agentColor, fontSize: 11, fontWeight: 700 }}>{shortName}</span>
        </div>
      )}
      <div className="wb-msg__body">
        {isUser ? (
          <p>{displayContent}</p>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {displayContent}
          </ReactMarkdown>
        )}
        <ActionBadge actionResult={actionResult} />
      </div>
    </div>
  )
}

const SESSION_KEY = 'quox-wb-executed-msgs'

/**
 * Inner chat UI — receives chatState from ChatEngine render prop.
 */
function WorkflowChatUI({ chatState, builder }) {
  const { messages, isProcessing, sendMessage, clearConversation, assistantConfig } = chatState
  const [input, setInput] = useState('')
  const [actionResults, setActionResults] = useState({})
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  // Tracks message IDs whose actions have already been executed.
  // Initialised from sessionStorage so refreshes within the same tab session
  // do not re-apply actions from rehydrated chat history.
  // sessionStorage (not localStorage) means the set dies when the tab closes,
  // matching the user's expectation that a new tab == clean slate.
  const [executedIds] = useState(() => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem(SESSION_KEY) || '[]'))
    } catch {
      return new Set()
    }
  })

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Focus input
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Parse and execute workflow actions from new assistant messages.
  // Uses executedIds (backed by sessionStorage) to skip messages whose actions
  // were already applied — including those rehydrated from localStorage on refresh.
  useEffect(() => {
    if (!builder || messages.length === 0) return

    for (const msg of messages) {
      if (msg.role === 'user') continue
      const msgKey = msg.messageId || msg.envelopeId || msg.id || msg.timestamp
      if (!msgKey || executedIds.has(msgKey)) continue

      executedIds.add(msgKey)
      sessionStorage.setItem(SESSION_KEY, JSON.stringify([...executedIds]))

      // Prefer tool-emitted actions (canvasActions from wb_emit) over markdown parsing
      let actions = []
      if (Array.isArray(msg.canvasActions) && msg.canvasActions.length > 0) {
        actions = msg.canvasActions
      } else {
        actions = parseActions(msg.text).actions
      }

      if (actions.length > 0) {
        const result = executeActions(actions, builder)
        setActionResults(prev => ({ ...prev, [msgKey]: result }))
      } else {
        // No actions parsed (plan-phase or text-only response) — record the zero
        // result so ActionBadge can render its "no canvas actions emitted" state.
        setActionResults(prev => ({ ...prev, [msgKey]: { applied: 0, errors: [] } }))
      }
    }
  }, [messages, builder, executedIds])

  const handleSubmit = useCallback((e) => {
    e.preventDefault()
    if (!input.trim() || isProcessing) return
    sendMessage(input)
    setInput('')
  }, [input, isProcessing, sendMessage])

  const handleChipSend = useCallback((text) => {
    sendMessage(text)
  }, [sendMessage])

  // Single "New conversation" reset — wipes chat memory + executed-action
  // tracking + canvas. The unified start-over: same effect a fresh page
  // load would have. Toolbar's Clear-canvas button stays for canvas-only
  // resets.
  const handleNewConversation = useCallback(() => {
    clearConversation()
    if (builder?.clear) builder.clear()
    executedIds.clear()
    sessionStorage.removeItem(SESSION_KEY)
    setActionResults({})
  }, [clearConversation, builder, executedIds])

  const agentName = assistantConfig?.name || 'WEAVER' // this panel is WEAVER; 'DAEDALUS' was a stale fallback

  return (
    <div className="wb-chat">
      <div className="wb-chat__header">
        <div className="wb-chat__title">
          <span className="wb-chat__agent-dot" style={{ background: assistantConfig?.color || '#30ff90' }} />
          <span>{agentName}</span>
          <span className="wb-chat__agent-role">Workflow Builder</span>
        </div>
        <div className="wb-chat__header-actions">
          {messages.length > 0 && (
            <button
              className="wb-chat__header-btn wb-chat__header-btn--label"
              onClick={handleNewConversation}
              title="Start over — clears chat history and canvas"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              <span>New conversation</span>
            </button>
          )}
        </div>
      </div>

      <div className="wb-chat__messages">
        {messages.length === 0 && !isProcessing && (
          <div className="wb-chat__welcome">
            <div className="wb-chat__welcome-icon" style={{ color: assistantConfig?.color || '#30ff90' }}>
              <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
            </div>
            <p>I'm <strong>{agentName}</strong>, your workflow builder assistant. Describe what you want to automate and I'll build it on the canvas.</p>
          </div>
        )}

        {messages.map((msg, i) => {
          const msgKey = msg.messageId || msg.envelopeId || msg.id || msg.timestamp
          return (
            <ChatMessage
              key={msgKey || i}
              message={msg}
              assistantConfig={assistantConfig}
              actionResult={actionResults[msgKey]}
            />
          )
        })}

        {isProcessing && (
          <div className="wb-msg wb-msg--ai">
            <div className="wb-msg__avatar" style={{
              borderColor: `${assistantConfig?.color || '#30ff90'}33`,
              background: `${assistantConfig?.color || '#30ff90'}15`
            }}>
              <span style={{ color: assistantConfig?.color || '#30ff90', fontSize: 11, fontWeight: 700 }}>
                {assistantConfig?.shortName || 'N'}
              </span>
            </div>
            <div className="wb-msg__body">
              <div className="wb-loading-dots">
                <span/><span/><span/>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <SuggestionChips
        nodes={builder?.nodes || []}
        edges={builder?.edges || []}
        onSend={handleChipSend}
      />

      <form className="wb-chat__input" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          type="text"
          placeholder={isProcessing ? `${agentName} is thinking...` : 'Describe what to build or change...'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isProcessing}
        />
        <button
          type="submit"
          disabled={!input.trim() || isProcessing}
          title="Send"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </form>
    </div>
  )
}

/**
 * WorkflowBuilderChat — Wraps ChatEngine with DAEDALUS agent.
 *
 * The contextBuilder injects the QuoxFlow system prompt + current workflow state
 * so DAEDALUS knows the node types and can emit structured actions.
 */
export function WorkflowBuilderChat({ builder }) {
  // Preload tool catalogs for all known agents on mount so DAEDALUS's prompt
  // can list real tool names. Stored in a ref so it never re-triggers renders.
  const agentToolsMapRef = useRef(null)

  useEffect(() => {
    const allAgentIds = [
      ...(agentRegistry.agents ? Object.keys(agentRegistry.agents) : []),
    ]
    if (allAgentIds.length === 0) return

    preloadAgentTools(allAgentIds).then(async () => {
      const map = new Map()
      for (const id of allAgentIds) {
        const tools = await getAgentTools(id)
        if (tools.length > 0) map.set(id, tools)
      }
      agentToolsMapRef.current = map
    }).catch(() => {
      // Preload failed — DAEDALUS will fall back to count-only catalog
    })
  }, []) // mount only

  // Context builder: injects workflow state + QuoxFlow knowledge into every message.
  // ChatEngine calls contextBuilder(userQuery) so we can surface relevant library
  // templates when the user's message contains workflow-design intent.
  const contextBuilder = useCallback(async (userQuery) => {
    const workflowContext = buildWorkflowContext(builder)
    // Pass the tool map if preload has completed; otherwise falls back to count-only
    return getSystemPromptWithLibrary(workflowContext, userQuery, agentToolsMapRef.current || undefined)
  }, [builder])

  return (
    <ChatEngine
      agent="weaver"
      contextBuilder={contextBuilder}
      sessionPrefix="WORKFLOW_BUILDER"
      enableSmartRouter={false}
      enableMemory={true}
      toolDenylist={WORKFLOW_BUILDER_TOOL_DENYLIST}
    >
      {(chatState) => (
        <WorkflowChatUI chatState={chatState} builder={builder} />
      )}
    </ChatEngine>
  )
}

export default WorkflowBuilderChat
