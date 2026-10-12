/**
 * AgentChatSidebar — Unified agent chat sidebar component.
 *
 * PSDK-1: Replaces 14 duplicated *ChatSidebar.jsx files with one reusable component.
 *
 * Usage:
 *   <AgentChatSidebar
 *     agentId="sentinel"
 *     agentName="WARDEN"
 *     agentColor="#30ff90"
 *     agentRole="Security Specialist"
 *     contextBuilder={async () => ({ surface: 'sidebar', ... })}
 *     suggestions={['Scan the network', 'Show alerts']}
 *     collapsed={sidebarCollapsed}
 *     onToggle={() => setSidebarCollapsed(c => !c)}
 *   />
 *
 * Extension points:
 *   - headerContent: React node rendered in the header (e.g. agent dropdown, protocol strip)
 *   - placeholder: input placeholder text
 *   - emptyIcon: SVG node for the empty state
 *   - className: additional CSS class for styling
 */

import { useRef, useCallback, useState } from 'react'
import { ChatEngine } from './ChatEngine'
import { VisualizerSection } from './sidebar/VisualizerSection'
import { ChatInput } from './input/ChatInput'
import { GlassChatPanel } from './glass'
import MarkdownContent from '../ui/MarkdownContent'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { useSettings } from '../../hooks/useSettings'

const defaultEmptyIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.3)', marginBottom: 8 }}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

// 14px speech-bubble icon used by the built-in 'chat' section tab.
const defaultChatIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

const newChatButton = (onClick) => (
  <button
    onClick={onClick}
    title="New chat"
    style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 24, height: 24, minHeight: 24, padding: 0, marginLeft: 'auto',
      background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 6, cursor: 'pointer', flexShrink: 0,
      transition: 'background 0.15s ease, border-color 0.15s ease',
    }}
  >
    <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
      <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  </button>
)

export function AgentChatSidebar({
  agentId,
  agentName,
  agentColor = '#30ff90',
  agentRole,
  avatarUrl,
  contextBuilder,
  suggestions = [],
  collapsed,
  onToggle,
  headerContent,
  placeholder,
  emptyIcon,
  emptyText,
  className = '',
  enableVoice = false,
  enableSmartRouter = true,
  enableMemory = true,
  sessionPrefix,
  vizStorageKey,
  // Renders its own glass panel by default; pass false where the parent already has one.
  panel = true,
  // extraSections: [{ id, label, badge?, content, }] — if provided, renders a
  // section toggle bar under the header. Chat is always the 'chat' section.
  extraSections,
  // Controlled mode: caller manages which section is active
  activeSection: activeSectionProp,
  onSectionChange,
  // Uncontrolled default (ignored if activeSectionProp provided)
  defaultSection = 'chat',
  // chatHandleRef: mutable ref — on each ChatEngine render, assigned
  // { send: (text) => void, clear: () => void } so parent can inject turns.
  chatHandleRef,
  // renderMessageAddon: optional render prop (msg) => ReactNode — called after
  // each assistant message body. Keeps the primitive agent-agnostic; callers
  // pass toolsmith-specific chips without coupling AgentChatSidebar to them.
  renderMessageAddon,
  // onAssistantMessage: forwarded to ChatEngine so callers can react to new
  // assistant messages (e.g. to extract proposedPatch).
  onAssistantMessage,
  // headerExtra: optional ReactNode injected at the right end of the header,
  // before the New Chat button and the collapse chevron. Used for surface-specific
  // header controls (e.g. Toolsmith auto-apply toggle).
  headerExtra,
}) {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const { getSetting } = useSettings()
  const useGlassChat = getSetting('useGlassChat', false)
  const messagesEndRef = useRef(null)
  const clearRef = useRef(null)
  const orgId = currentOrg?.id

  // Section state — controlled if activeSectionProp is provided, uncontrolled otherwise
  const [internalSection, setInternalSection] = useState(defaultSection)
  const hasExtraSections = extraSections && extraSections.length > 0
  const activeSection = hasExtraSections
    ? (activeSectionProp !== undefined ? activeSectionProp : internalSection)
    : 'chat'

  const handleSectionChange = useCallback((id) => {
    if (activeSectionProp === undefined) setInternalSection(id)
    if (onSectionChange) onSectionChange(id)
  }, [activeSectionProp, onSectionChange])

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const prefix = sessionPrefix || `${(agentId || 'agent').toUpperCase()}_SIDEBAR`
  const inputPlaceholder = placeholder || `Ask ${agentName || agentId?.toUpperCase() || 'agent'}...`
  const name = agentName || agentId?.toUpperCase() || 'Agent'

  // Collapsed state
  if (collapsed) {
    return (
      <div
        onClick={onToggle}
        style={{
          width: 48, height: '100%',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 8, cursor: 'pointer',
          backdropFilter: 'var(--glass-blur-strong)',
          WebkitBackdropFilter: 'var(--glass-blur-strong)',
          background: 'linear-gradient(145deg, rgba(255,255,255,0.015), rgba(255,255,255,0.003))',
          borderLeft: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '12px 0 0 12px',
        }}
      >
        <div style={{
          fontFamily: "'JetBrains Mono','Fira Code',monospace",
          fontSize: 10, fontWeight: 700, color: agentColor,
          writingMode: 'vertical-rl', letterSpacing: 2,
        }}>
          {name}
        </div>
      </div>
    )
  }

  /* `panel` defaults to TRUE so a sidebar dropped onto a NEW surface is a correct glass
     panel out of the box. It used to default to transparent-with-no-border, which meant
     every new surface rendered an invisible sidebar until someone noticed and hand-wrapped
     it in an <aside> carrying the recipe. That silent-wrong default cost a round of "the
     sidebar has no background" on multiple surfaces. Pass panel={false} ONLY where the
     parent already provides the glass (bastion, inbox), or you get glass on glass. */
  const panelClass = panel ? ' agent-chat-sidebar--panel' : ''

  return (
    <div
      className={`agent-chat-sidebar${panelClass} ${className}`}
      style={{
        display: 'flex', flexDirection: 'column', height: '100%',
        overflow: 'hidden',
        position: 'relative',
        zIndex: 1,
      }}
    >
      {/* Header */}
      <div style={{
        padding: '10px 12px', flexShrink: 0,
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {headerContent || (
          <>
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={name}
                style={{
                  width: 20, height: 20, borderRadius: 4,
                  flexShrink: 0, objectFit: 'contain',
                }}
              />
            ) : (
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: agentColor,
                boxShadow: `0 0 6px ${agentColor}60`,
                flexShrink: 0,
              }} />
            )}
            <span style={{
              fontFamily: "'JetBrains Mono','Fira Code',monospace",
              fontSize: 12, fontWeight: 700, color: agentColor,
            }}>
              {name}
            </span>
            {agentRole && (
              <span style={{
                fontFamily: "'Inter',system-ui,sans-serif",
                fontSize: 10, color: 'rgba(255,255,255,0.5)',
              }}>
                {agentRole}
              </span>
            )}
          </>
        )}
        {headerExtra && headerExtra}
        {newChatButton(() => clearRef.current?.())}
        {onToggle && (
          <button
            onClick={onToggle}
            style={{
              background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)',
              cursor: 'pointer', fontSize: 14, padding: 0, flexShrink: 0,
            }}
          >
            &#10094;
          </button>
        )}
      </div>

      {/* Section toggle bar — only rendered when extraSections are present */}
      {hasExtraSections && (
        <div style={{
          display: 'flex', flexShrink: 0,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          padding: '0 8px',
          gap: 2,
        }}>
          {[{ id: 'chat', label: 'Chat', icon: defaultChatIcon }, ...extraSections].map(({ id, label, badge, icon }) => {
            const isActive = activeSection === id
            return (
              <button
                key={id}
                onClick={() => handleSectionChange(id)}
                title={label}
                style={{
                  fontFamily: "'Inter',system-ui,sans-serif",
                  fontSize: 12, fontWeight: 600,
                  color: isActive ? agentColor : 'var(--text-secondary, rgba(255,255,255,0.6))',
                  background: 'none', border: 'none',
                  borderBottom: isActive ? `2px solid ${agentColor}` : '2px solid transparent',
                  padding: '8px 10px 6px',
                  cursor: 'pointer', flexShrink: 0,
                  display: 'flex', alignItems: 'center', gap: 6,
                  transition: 'color 0.15s ease, border-color 0.15s ease',
                }}
              >
                {icon && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
                    {icon}
                  </span>
                )}
                <span>{label}</span>
                {badge != null && badge > 0 && (
                  <span style={{
                    background: agentColor, color: '#000',
                    borderRadius: 999, fontSize: 10, fontWeight: 700,
                    padding: '1px 5px', lineHeight: 1.4,
                  }}>
                    {badge}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Chat body */}
      <ChatEngine
        agent={agentId}
        contextBuilder={contextBuilder}
        sessionPrefix={prefix}
        surface="sidebar"
        surfaceContext={{ page: name, panel: `${name} sidebar` }}
        enableSmartRouter={enableSmartRouter}
        enableMemory={enableMemory}
        authFetch={authFetch}
        orgId={orgId}
        enablePersistence={!!orgId}
        onAssistantMessage={onAssistantMessage}
      >
        {(chatState) => {
          const {
            messages = [],
            isProcessing = false,
            halState,
            sendMessage = () => {},
            abortMessage,
            clearConversation,
          } = chatState || {}
          clearRef.current = clearConversation

          const handleSend = (text) => {
            if (!text || isProcessing) return
            sendMessage(text)
            setTimeout(scrollToBottom, 100)
          }

          // Wire chatHandleRef so parent can inject turns and clear the conversation
          if (chatHandleRef) {
            chatHandleRef.current = {
              send: (text) => handleSend(text),
              clear: () => clearConversation?.(),
            }
          }

          const messageList = (
            <>
              {messages.length === 0 && !isProcessing && (
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', padding: '32px 16px',
                  color: 'rgba(255,255,255,0.4)',
                  fontFamily: "'Inter',system-ui,sans-serif", fontSize: 12,
                  textAlign: 'center', gap: 8,
                }}>
                  {emptyIcon || defaultEmptyIcon}
                  <span>{emptyText || `Ask ${name} anything...`}</span>
                  {suggestions.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12, justifyContent: 'center', padding: '0 12px' }}>
                      {suggestions.slice(0, 6).map((s, i) => (
                        <button
                          key={i}
                          className="agent-chat-sidebar__suggestion"
                          onClick={() => handleSend(s)}
                          style={{ '--agent-color': agentColor }}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {messages.map((msg, i) => (
                <div
                  key={msg.messageId || i}
                  style={{
                    padding: '8px 12px', margin: '4px 8px',
                    borderRadius: 8,
                    background: msg.role === 'user' ? 'rgba(168,85,247,0.06)' : 'rgba(255,255,255,0.02)',
                    borderLeft: msg.role === 'user' ? '2px solid rgba(168,85,247,0.3)' : `2px solid ${agentColor}30`,
                    fontSize: 12, color: '#fff', lineHeight: 1.5,
                    wordBreak: 'break-word',
                  }}
                >
                  <div style={{
                    fontFamily: "'Inter',system-ui,sans-serif",
                  }}>
                    {msg.role === 'user'
                      ? <span style={{ whiteSpace: 'pre-wrap' }}>{msg.text || msg.content || ''}</span>
                      : <MarkdownContent>{msg.text || msg.content || ''}</MarkdownContent>
                    }
                    {msg.role === 'assistant' && renderMessageAddon && renderMessageAddon(msg)}
                  </div>
                </div>
              ))}
              {isProcessing && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '8px 12px', margin: '4px 8px',
                }}>
                  {[0, 1, 2].map(i => (
                    <span key={i} style={{
                      width: 6, height: 6, borderRadius: '50%', background: agentColor,
                      opacity: 0.6, animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                    }} />
                  ))}
                  <style>{`@keyframes pulse { 0%, 100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }`}</style>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )

          const chatVisible = activeSection === 'chat'
          const chatDisplayStyle = chatVisible ? 'flex' : 'none'

          if (useGlassChat) {
            return (
              <>
                <div style={{ flex: chatVisible ? 1 : 0, display: chatDisplayStyle, flexDirection: 'column', minHeight: 0 }}>
                  <GlassChatPanel
                    variant="compact"
                    agent={agentId}
                    halState={halState || 'idle'}
                    isProcessing={isProcessing}
                    onSend={handleSend}
                    onStop={abortMessage}
                    placeholder={inputPlaceholder}
                    enableVoice={enableVoice}
                  >
                    <div style={{ flex: 1, overflowY: 'auto' }}>{messageList}</div>
                  </GlassChatPanel>
                </div>
                {hasExtraSections && extraSections.map(({ id, content }) => (
                  <div
                    key={id}
                    data-agent-color={agentColor}
                    style={{
                      flex: activeSection === id ? 1 : 0,
                      display: activeSection === id ? 'flex' : 'none',
                      flexDirection: 'column',
                      minHeight: 0,
                      overflow: 'hidden',
                    }}
                  >
                    {content}
                  </div>
                ))}
              </>
            )
          }

          return (
            <>
              <div style={{ flex: chatVisible ? 1 : 0, display: chatDisplayStyle, flexDirection: 'column', minHeight: 0 }}>
                {/* Visualizer — in DevShell contexts (extraSections present) the rail
                    is short; cap visualizer to 40% of available height and start it
                    collapsed so input + messages always have room. */}
                <div style={{
                  flexShrink: 0,
                  maxHeight: hasExtraSections ? '40%' : 'none',
                  overflow: hasExtraSections ? 'hidden' : 'visible',
                }}>
                  <VisualizerSection
                    agent={agentId}
                    state={halState || 'idle'}
                    showVoice={enableVoice}
                    showControls={true}
                    showStatus={false}
                    defaultCollapsed={hasExtraSections}
                    storageKey={vizStorageKey || (hasExtraSections ? `${agentId}-viz-collapsed-devshell` : `${agentId}-viz-collapsed`)}
                  />
                </div>

                {/* Messages */}
                <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                  {messageList}
                </div>

                {/* Input */}
                <div style={{ flexShrink: 0, padding: '8px' }}>
                  <ChatInput
                    onSend={handleSend}
                    onStop={abortMessage}
                    placeholder={inputPlaceholder}
                    isProcessing={isProcessing}
                    enableVoice={enableVoice}
                    enableFileUpload={false}
                    hints={false}
                    maxRows={3}
                  />
                </div>
              </div>
              {hasExtraSections && extraSections.map(({ id, content }) => (
                <div
                  key={id}
                  data-agent-color={agentColor}
                  style={{
                    flex: activeSection === id ? 1 : 0,
                    display: activeSection === id ? 'flex' : 'none',
                    flexDirection: 'column',
                    minHeight: 0,
                    overflow: 'hidden',
                  }}
                >
                  {content}
                </div>
              ))}
            </>
          )
        }}
      </ChatEngine>
    </div>
  )
}

export default AgentChatSidebar
