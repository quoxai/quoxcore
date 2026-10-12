/**
 * BrowserQSidebar — Persistent BROWSER-Q agent chat sidebar for BrowserQView.
 *
 * Follows the ActionQSidebar pattern: context-aware chat with suggestion chips,
 * collapsible with localStorage persistence.
 *
 * Accepts `suggestion` prop — when set, pre-fills the chat input.
 * Accepts `activeTab` + `isFirstUse` for context-aware system prompts.
 */

import { useRef, useCallback, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChatEngine } from '../chat/ChatEngine'
import { VisualizerSection } from '../chat/sidebar/VisualizerSection'
import SidebarNewChatButton from '../chat/sidebar/SidebarNewChatButton'
import { ChatInput } from '../chat/input/ChatInput'
import { GlassChatPanel } from '../chat/glass'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { useSettings } from '../../hooks/useSettings'
import { listBrowserCredentials, listAgenticBrowserRuns, createAgenticBrowserRun } from '../../services/browserQService'
import './browser-q-sidebar.css'

// ── Suggestion chips ──

const SUGGESTIONS = [
  'Go to quox.ai and screenshot the homepage',
  'Extract all links from github.com/quoxai',
  'Fill the contact form on a website',
  'Monitor quox.ai for visual changes',
  'Log into Grafana and screenshot the overview',
]

// ── Context builder ──

function buildBrowserContext({ activeTab, isFirstUse } = {}) {
  const summary = [
    { label: 'Browser session', value: 'No active browser session' },
    { label: 'Browser engine', value: 'Puppeteer (Chromium headless)' },
  ]

  if (activeTab) {
    summary.push({ label: 'Active tab', value: activeTab })
  }

  const evidence = [
    {
      label: 'Available tools',
      text: 'browser_navigate, browser_screenshot, browser_extract, browser_click, browser_type, browser_wait, browser_scroll'
    }
  ]

  if (isFirstUse) {
    evidence.push({
      label: 'First use',
      text: 'No sessions, sequences, monitors, or videos yet'
    })
  }

  return {
    surface: 'sidebar',
    page: 'Browser-Q',
    panel: 'BROWSER-Q automation sidebar',
    focus: activeTab
      ? {
          type: 'Dashboard tab',
          label: activeTab,
          id: activeTab,
          detail: isFirstUse ? 'First-use view' : 'Active Browser-Q tab'
        }
      : {
          type: 'Automation overview',
          label: 'Browser-Q dashboard',
          detail: isFirstUse ? 'First-use state' : 'No active browser session'
        },
    summary,
    evidenceTitle: 'Browser automation state',
    evidence,
    instructions: [
      'You are BROWSER-Q, the web automation specialist. Help the user automate web tasks.',
      'Explain what you can do and walk through setting up an automation step by step.',
      'You have full browser control: navigate, click, type, extract data, fill forms, take screenshots, and more.',
      isFirstUse ? 'Be welcoming and proactive. Suggest taking a screenshot of a website as a simple first task to build confidence.' : null,
    ].filter(Boolean),
  }
}

// ── Quick Actions Panel ──

function QuickActionsPanel({ authFetch, orgId }) {
  const navigate = useNavigate()
  const [quickUrl, setQuickUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [recentRuns, setRecentRuns] = useState([])
  const [credentials, setCredentials] = useState([])
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('bqs-quick-collapsed') === 'true' } catch { return false }
  })

  // Fetch recent runs + credentials
  useEffect(() => {
    if (!authFetch || !orgId) return
    listAgenticBrowserRuns(authFetch, orgId, 5)
      .then(runs => setRecentRuns(runs.slice(0, 5)))
      .catch(() => {})
    listBrowserCredentials(authFetch, orgId)
      .then(creds => setCredentials(creds || []))
      .catch(() => {})
  }, [authFetch, orgId])

  const toggleCollapsed = useCallback(() => {
    setCollapsed(v => {
      try { localStorage.setItem('bqs-quick-collapsed', String(!v)) } catch {}
      return !v
    })
  }, [])

  const handleQuickUrl = useCallback(async (e) => {
    e.preventDefault()
    const url = quickUrl.trim()
    if (!url || submitting) return
    setSubmitting(true)
    try {
      const result = await createAgenticBrowserRun(`Screenshot and extract content from ${url}`, url)
      if (result?.executionId) {
        navigate(`/executions/${result.executionId}`)
      }
    } catch (err) {
      console.error('Quick URL failed:', err)
    } finally {
      setSubmitting(false)
      setQuickUrl('')
    }
  }, [quickUrl, submitting, navigate])

  return (
    <div className="bqs-quick">
      <button className="bqs-quick__toggle" onClick={toggleCollapsed}>
        <span className="bqs-quick__toggle-arrow">{collapsed ? '\u25B8' : '\u25BE'}</span>
        <span>Quick Actions</span>
        <span className="bqs-quick__toggle-count">
          {credentials.length} creds {'\u00B7'} {recentRuns.length} recent
        </span>
      </button>

      {!collapsed && (
        <div className="bqs-quick__body">
          {/* Quick URL */}
          <form onSubmit={handleQuickUrl} className="bqs-quick__url-form">
            <input
              type="url"
              value={quickUrl}
              onChange={e => setQuickUrl(e.target.value)}
              placeholder="Paste URL..."
              disabled={submitting}
              className="bqs-quick__url-input"
            />
            <button
              type="submit"
              disabled={!quickUrl.trim() || submitting}
              className="bqs-quick__url-btn"
            >
              {submitting ? '...' : '\u{1F4F7}'}
            </button>
          </form>

          {/* Recent Runs */}
          {recentRuns.length > 0 && (
            <div className="bqs-quick__section">
              <div className="bqs-quick__section-label">RECENT</div>
              {recentRuns.map(run => (
                <button
                  key={run.id}
                  className="bqs-quick__run"
                  onClick={() => navigate(`/browser-q/run/${run.id}`)}
                >
                  <span className="bqs-quick__run-dot" style={{
                    background: run.status === 'completed' ? '#30ff90'
                      : run.status === 'failed' ? '#ef4444'
                      : run.status === 'running' ? '#38bdf8'
                      : 'rgba(255,255,255,0.6)'
                  }} />
                  <span className="bqs-quick__run-title">{run.title || run.intent || 'Untitled'}</span>
                </button>
              ))}
            </div>
          )}

          {/* Credentials */}
          {credentials.length > 0 && (
            <div className="bqs-quick__section">
              <div className="bqs-quick__section-label">VAULT ({credentials.length})</div>
              {credentials.slice(0, 3).map(c => (
                <div key={c.id} className="bqs-quick__cred">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: '#f59e0b', flexShrink: 0 }}>
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <span>{c.label || c.domain}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main component ──

export function BrowserQSidebar({ suggestion, onSuggestionConsumed, activeTab, isFirstUse }) {
  const { getSetting } = useSettings()
  const useGlassChat = getSetting('useGlassChat', false)
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const messagesEndRef = useRef(null)
  const clearRef = useRef(null)
  const orgId = currentOrg?.id
  const [pendingSuggestion, setPendingSuggestion] = useState('')

  // When parent sends a suggestion, capture it
  useEffect(() => {
    if (suggestion) {
      setPendingSuggestion(suggestion)
      onSuggestionConsumed?.()
    }
  }, [suggestion, onSuggestionConsumed])

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const buildContext = useCallback(async () => {
    return buildBrowserContext({ activeTab, isFirstUse })
  }, [activeTab, isFirstUse])

  return (
    <div className="bqs">
      <ChatEngine
        agent="browser-q"
        contextBuilder={buildContext}
        sessionPrefix="BROWSER_Q"
        surface="sidebar"
        surfaceContext={{
          page: 'Browser-Q',
          panel: 'BROWSER-Q automation sidebar',
        }}
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
            setPendingSuggestion('')
            setTimeout(scrollToBottom, 100)
          }

          const messageList = (
            <>
              {messages.length === 0 && (
                <div className="bqs-empty">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(6, 182, 212, 0.5)', marginBottom: 8 }}>
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                  <span>Ask BROWSER-Q anything...</span>
                  <div className="bqs-suggestions">
                    {SUGGESTIONS.map((s, i) => (
                      <button key={i} className="bqs-chip" onClick={() => handleSend(s)}>{s}</button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((msg, i) => (
                <div
                  key={msg.messageId || i}
                  className={`bqs-msg bqs-msg--${msg.role === 'user' ? 'user' : 'assistant'}`}
                >
                  <div className="bqs-msg__text">{msg.text}</div>
                </div>
              ))}
              {isProcessing && (
                <div className="bqs-msg bqs-msg--assistant">
                  <div className="bqs-typing"><span /><span /><span /></div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )

          if (useGlassChat) {
            return (
              <>
                {/* Header */}
                <div className="bqs-header">
                  <div className="bqs-header__agent">
                    <span className="bqs-header__dot" />
                    <span className="bqs-header__name">BROWSER-Q</span>
                  </div>
                  <span className="bqs-header__role">Web Automation</span>
                  <SidebarNewChatButton onClick={() => clearRef.current?.()} />
                </div>

                <QuickActionsPanel authFetch={authFetch} orgId={orgId} />

                <div className="bqs-chat-body">
                  <GlassChatPanel
                    variant="compact"
                    agent="browser-q"
                    halState={halState || 'idle'}
                    isProcessing={isProcessing}
                    onSend={handleSend}
                    onStop={abortMessage}
                    placeholder="Ask BROWSER-Q..."
                    enableVoice={false}
                  >
                    <div className="bqs-messages">{messageList}</div>
                  </GlassChatPanel>
                </div>
              </>
            )
          }

          return (
            <>
              {/* Header */}
              <div className="bqs-header">
                <div className="bqs-header__agent">
                  <span className="bqs-header__dot" />
                  <span className="bqs-header__name">BROWSER-Q</span>
                </div>
                <span className="bqs-header__role">Web Automation</span>
                <SidebarNewChatButton onClick={() => clearRef.current?.()} />
              </div>

              {/* Quick Actions */}
              <QuickActionsPanel authFetch={authFetch} orgId={orgId} />

              {/* Visualizer */}
              <div className="bqs-viz">
                <VisualizerSection
                  agent="browser-q"
                  state={halState || 'idle'}
                  showVoice={false}
                  showControls={true}
                  showStatus={false}
                  defaultCollapsed={true}
                  storageKey="browser-q-sidebar-viz-collapsed"
                />
              </div>

              {/* Chat body */}
              <div className="bqs-chat-body">
                <div className="bqs-messages">{messageList}</div>

                <div className="bqs-input-wrap">
                  <SuggestionInput
                    pendingSuggestion={pendingSuggestion}
                    onClear={() => setPendingSuggestion('')}
                    onSend={handleSend}
                    onStop={abortMessage}
                    isProcessing={isProcessing}
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

/**
 * SuggestionInput — wraps ChatInput with external suggestion pre-fill.
 * When pendingSuggestion is set, it shows as a pre-filled editable bar
 * above the normal input, with a Send button.
 */
function SuggestionInput({ pendingSuggestion, onClear, onSend, onStop, isProcessing }) {
  const [editedText, setEditedText] = useState('')

  useEffect(() => {
    if (pendingSuggestion) {
      setEditedText(pendingSuggestion)
    }
  }, [pendingSuggestion])

  if (pendingSuggestion && editedText) {
    return (
      <div className="bqs-suggestion-bar">
        <input
          type="text"
          className="bqs-suggestion-bar__input"
          value={editedText}
          onChange={e => setEditedText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && editedText.trim()) {
              onSend(editedText.trim())
              setEditedText('')
              onClear()
            } else if (e.key === 'Escape') {
              setEditedText('')
              onClear()
            }
          }}
          autoFocus
        />
        <button
          className="bqs-suggestion-bar__send"
          onClick={() => {
            if (editedText.trim()) {
              onSend(editedText.trim())
              setEditedText('')
              onClear()
            }
          }}
          disabled={isProcessing || !editedText.trim()}
        >
          Send
        </button>
        <button
          className="bqs-suggestion-bar__cancel"
          onClick={() => { setEditedText(''); onClear() }}
        >
          {'\u2715'}
        </button>
      </div>
    )
  }

  return (
    <ChatInput
      onSend={onSend}
      onStop={onStop}
      placeholder="Ask BROWSER-Q..."
      isProcessing={isProcessing}
      enableVoice={false}
      enableFileUpload={false}
      hints={false}
      maxRows={3}
    />
  )
}

export default BrowserQSidebar
