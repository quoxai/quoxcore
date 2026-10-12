/**
 * QuoxChat Embeddable Widget (CW-3)
 *
 * Preact-compatible component that renders inside a Shadow DOM.
 * This is the main widget UI — trigger button + expandable chat panel.
 *
 * NOTE: This file uses React (not Preact) for now since it lives in the dashboard repo.
 * When built as a standalone widget bundle, it would be compiled with Preact for size.
 * The component API is Preact-compatible (no React-specific features).
 *
 * Features:
 *   - Floating trigger button (configurable position)
 *   - Expandable chat panel with header, messages, input
 *   - Mobile responsive (full-width bottom sheet on <768px)
 *   - CSS custom properties for all styling
 *   - SSE connection stub for streaming responses
 *   - AI disclosure badge (EU AI Act Art. 50)
 *   - "Powered by QuoxChat" badge (removable on Standard)
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { parseWidgetConfig, getDefaultCSSVariables, isMobileViewport, buildWidgetEndpointURL } from './widgetConfig'
import { getOrCreateVisitorId, buildMessagePayload, sendMessage, renderMarkdown } from './widgetComms'

// ── Inline Styles (Shadow DOM — no external CSS) ────────────────────────────

const WIDGET_STYLES = `
  :host {
    all: initial;
    font-family: var(--qc-font, 'Inter', system-ui, sans-serif);
    font-size: var(--qc-font-size, 14px);
    line-height: var(--qc-line-height, 1.5);
    color: var(--qc-text, #1a1a1a);
  }

  *, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  .qc-trigger {
    position: var(--qc-position, fixed);
    bottom: var(--qc-bottom, 20px);
    right: var(--qc-right, 20px);
    left: var(--qc-left, auto);
    z-index: var(--qc-z-index, 9999);
    width: var(--qc-trigger-size, 56px);
    height: var(--qc-trigger-size, 56px);
    border-radius: var(--qc-trigger-radius, 50%);
    background: var(--qc-trigger-bg, #7c3aed);
    color: var(--qc-trigger-text, #ffffff);
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: var(--qc-trigger-shadow, 0 4px 16px rgba(124,58,237,0.3));
    transition: transform var(--qc-transition, 0.25s cubic-bezier(0.4, 0, 0.2, 1)),
                box-shadow var(--qc-transition, 0.25s cubic-bezier(0.4, 0, 0.2, 1));
  }

  .qc-trigger:hover {
    transform: scale(1.08);
    box-shadow: 0 6px 24px rgba(124,58,237,0.4);
  }

  .qc-trigger:active {
    transform: scale(0.95);
  }

  .qc-trigger svg {
    width: 24px;
    height: 24px;
    fill: currentColor;
  }

  .qc-panel {
    position: var(--qc-position, fixed);
    bottom: calc(var(--qc-bottom, 20px) + var(--qc-trigger-size, 56px) + 12px);
    right: var(--qc-right, 20px);
    left: var(--qc-left, auto);
    z-index: var(--qc-z-index, 9999);
    width: var(--qc-width, 380px);
    height: var(--qc-height, 520px);
    max-height: 80vh;
    border-radius: var(--qc-radius, 16px);
    background: var(--qc-bg, #ffffff);
    box-shadow: var(--qc-shadow, 0 8px 32px rgba(0,0,0,0.12));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: qc-slide-up 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Mobile: bottom sheet */
  @media (max-width: 767px) {
    .qc-panel {
      width: var(--qc-mobile-width, 100%) !important;
      height: var(--qc-mobile-height, 80vh) !important;
      max-height: 90vh;
      bottom: 0 !important;
      right: 0 !important;
      left: 0 !important;
      border-radius: var(--qc-radius, 16px) var(--qc-radius, 16px) 0 0;
      /* iOS safe area */
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }

    .qc-trigger {
      bottom: calc(var(--qc-bottom, 16px) + env(safe-area-inset-bottom, 0px));
      right: var(--qc-right, 16px);
    }
  }

  @keyframes qc-slide-up {
    from { opacity: 0; transform: translateY(16px) scale(0.96); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .qc-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px var(--qc-padding, 16px);
    background: var(--qc-header-bg, #7c3aed);
    color: var(--qc-header-text, #ffffff);
    min-height: var(--qc-header-height, 56px);
    flex-shrink: 0;
  }

  .qc-header__avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: rgba(255,255,255,0.2);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 13px;
    flex-shrink: 0;
  }

  .qc-header__info {
    flex: 1;
    min-width: 0;
  }

  .qc-header__name {
    font-size: 14px;
    font-weight: 700;
  }

  .qc-header__status {
    font-size: 11px;
    opacity: 0.8;
  }

  .qc-header__close {
    background: rgba(255,255,255,0.15);
    border: none;
    color: inherit;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    transition: background 0.15s;
    flex-shrink: 0;
  }

  .qc-header__close:hover {
    background: rgba(255,255,255,0.25);
  }

  .qc-messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--qc-padding, 16px);
    display: flex;
    flex-direction: column;
    gap: var(--qc-gap, 8px);
  }

  .qc-messages::-webkit-scrollbar { width: 4px; }
  .qc-messages::-webkit-scrollbar-track { background: transparent; }
  .qc-messages::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 2px; }

  .qc-bubble {
    max-width: 85%;
    padding: 10px 14px;
    border-radius: var(--qc-bubble-radius, 16px);
    font-size: var(--qc-font-size, 14px);
    line-height: var(--qc-line-height, 1.5);
    word-wrap: break-word;
  }

  .qc-bubble--user {
    align-self: flex-end;
    background: var(--qc-bubble-user-bg, #7c3aed);
    color: var(--qc-bubble-user-text, #ffffff);
    border-bottom-right-radius: 4px;
  }

  .qc-bubble--bot {
    align-self: flex-start;
    background: var(--qc-bubble-bot-bg, #f3f4f6);
    color: var(--qc-bubble-bot-text, #1a1a1a);
    border-bottom-left-radius: 4px;
  }

  .qc-citation {
    display: inline-block;
    margin-top: 6px;
    padding: 2px 8px;
    border-radius: var(--qc-citation-radius, 4px);
    background: var(--qc-citation-bg, rgba(124,58,237,0.06));
    color: var(--qc-citation-text, #7c3aed);
    font-size: var(--qc-font-size-small, 12px);
    font-weight: 500;
  }

  .qc-typing {
    align-self: flex-start;
    display: flex;
    gap: 4px;
    padding: 12px 16px;
    background: var(--qc-bubble-bot-bg, #f3f4f6);
    border-radius: var(--qc-bubble-radius, 16px);
  }

  .qc-typing__dot {
    width: var(--qc-typing-dot-size, 6px);
    height: var(--qc-typing-dot-size, 6px);
    border-radius: 50%;
    background: var(--qc-typing-dot-color, #7c3aed);
    animation: qc-bounce 1.4s infinite ease-in-out;
  }

  .qc-typing__dot:nth-child(1) { animation-delay: 0s; }
  .qc-typing__dot:nth-child(2) { animation-delay: 0.2s; }
  .qc-typing__dot:nth-child(3) { animation-delay: 0.4s; }

  @keyframes qc-bounce {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
    40% { transform: scale(1); opacity: 1; }
  }

  .qc-input-area {
    display: flex;
    gap: 8px;
    padding: 12px var(--qc-padding, 16px);
    border-top: 1px solid var(--qc-input-border, #e5e7eb);
    background: var(--qc-input-bg, #ffffff);
    flex-shrink: 0;
  }

  .qc-input {
    flex: 1;
    padding: 10px 14px;
    border: 1px solid var(--qc-input-border, #e5e7eb);
    border-radius: var(--qc-input-radius, 12px);
    font-size: var(--qc-font-size, 14px);
    font-family: var(--qc-font, 'Inter', system-ui, sans-serif);
    background: var(--qc-input-bg, #ffffff);
    color: var(--qc-input-text, #1a1a1a);
    outline: none;
    transition: border-color 0.15s;
    min-height: 44px; /* Touch-friendly */
  }

  .qc-input::placeholder {
    color: var(--qc-input-placeholder, #9ca3af);
  }

  .qc-input:focus {
    border-color: var(--qc-accent, #7c3aed);
    box-shadow: 0 0 0 2px rgba(124,58,237,0.1);
  }

  .qc-send {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--qc-accent, #7c3aed);
    color: #ffffff;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s, transform 0.15s;
  }

  .qc-send:hover { background: var(--qc-accent-hover, #6d28d9); }
  .qc-send:active { transform: scale(0.93); }
  .qc-send:disabled { opacity: 0.5; cursor: not-allowed; }

  .qc-send svg {
    width: 18px;
    height: 18px;
    fill: currentColor;
  }

  .qc-branding {
    display: var(--qc-branding-display, flex);
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px;
    font-size: var(--qc-branding-size, 10px);
    color: var(--qc-branding-text, #9ca3af);
    border-top: 1px solid var(--qc-input-border, #e5e7eb);
    flex-shrink: 0;
  }

  .qc-disclosure {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    font-size: 9px;
    color: var(--qc-text-secondary, #6b7280);
    background: rgba(0,0,0,0.03);
    border-radius: 4px;
    margin: 0 var(--qc-padding, 16px) 4px;
  }
`

// ── Icons (inline SVG) ──────────────────────────────────────────────────────

const ChatIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
)

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
)

const SendIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
)

// ── Main Widget Component ───────────────────────────────────────────────────

export default function QuoxChatWidget({ config: externalConfig, container }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  const config = externalConfig || parseWidgetConfig({})

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, typing])

  // Focus input when panel opens
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Add greeting on first open
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{
        id: 'greeting',
        role: 'bot',
        content: config.greeting || 'Hi! How can I help you today?',
      }])
    }
  }, [open])

  // Get or create visitor ID
  const visitorId = useRef(null)
  if (!visitorId.current) {
    visitorId.current = getOrCreateVisitorId(config.widgetId)
  }

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text) return

    setInput('')
    const userMsg = { id: `user-${Date.now()}`, role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setTyping(true)

    // Build conversation history from current messages
    const history = messages.filter(m => m.id !== 'greeting').map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }))
    history.push({ role: 'user', content: text })

    // Call real backend
    const payload = buildMessagePayload({
      message: text,
      widgetId: config.widgetId,
      visitorId: visitorId.current,
      conversationHistory: history,
      pageUrl: typeof window !== 'undefined' ? window.location.pathname : '',
    })

    const result = await sendMessage(config.endpoint, payload)

    setMessages(prev => [...prev, {
      id: `bot-${Date.now()}`,
      role: 'bot',
      content: result.text,
      sources: result.sources,
      meta: result.meta,
      isError: result.error,
    }])
    setTyping(false)
  }, [input, messages, config])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <>
      <style>{WIDGET_STYLES}</style>

      {/* Trigger button */}
      {!open && (
        <button className="qc-trigger" onClick={() => setOpen(true)} aria-label="Open chat" part="trigger-button">
          <ChatIcon />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="qc-panel" part="panel" role="dialog" aria-label="Chat">
          {/* Header */}
          <div className="qc-header" part="header">
            <div className="qc-header__avatar" part="header-avatar">
              {config.greeting?.charAt(0) || '💬'}
            </div>
            <div className="qc-header__info">
              <div className="qc-header__name" part="header-title">Assistant</div>
              <div className="qc-header__status">Online</div>
            </div>
            <button className="qc-header__close" onClick={() => setOpen(false)} aria-label="Close chat">
              <CloseIcon />
            </button>
          </div>

          {/* AI disclosure (EU AI Act Art. 50) */}
          <div className="qc-disclosure" part="disclosure">
            <span>🤖</span> This is an AI assistant
          </div>

          {/* Messages */}
          <div className="qc-messages" part="message-list">
            {messages.map(msg => (
              <div key={msg.id} className={`qc-bubble qc-bubble--${msg.role}${msg.isError ? ' qc-bubble--error' : ''}`} part={`message-bubble message-bubble-${msg.role}`}>
                {msg.role === 'bot'
                  ? <span dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                  : msg.content}
                {msg.sources && msg.sources.length > 0 && (
                  <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {msg.sources.map((s, i) => (
                      <span key={i} className="qc-citation" part="source-citation">
                        {s.title || s.source}{s.section ? ` › ${s.section}` : ''}
                      </span>
                    ))}
                  </div>
                )}
                {msg.meta && msg.meta.model && (
                  <div style={{ marginTop: 4, fontSize: '10px', opacity: 0.5, fontFamily: 'var(--qc-font-mono, monospace)' }}>
                    {msg.meta.model} · {msg.meta.tokens} tok · {msg.meta.latency}
                  </div>
                )}
              </div>
            ))}
            {typing && (
              <div className="qc-typing" part="typing-indicator">
                <div className="qc-typing__dot" />
                <div className="qc-typing__dot" />
                <div className="qc-typing__dot" />
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="qc-input-area" part="input-area">
            <input
              ref={inputRef}
              className="qc-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              part="input-field"
              aria-label="Message input"
            />
            <button className="qc-send" onClick={handleSend} disabled={!input.trim()} part="send-button" aria-label="Send message">
              <SendIcon />
            </button>
          </div>

          {/* Branding */}
          {config.showBranding && (
            <div className="qc-branding" part="powered-by">
              Powered by QuoxChat
            </div>
          )}
        </div>
      )}
    </>
  )
}
