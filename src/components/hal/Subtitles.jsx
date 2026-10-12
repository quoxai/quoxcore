import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getAllAssistants } from '../../config/assistants'
import { buildAssistantIdentityList, resolveAssistantIdentity } from '../../services/assistantIdentity'

// Minimal markdown components for chat - inline styles only
const chatMarkdownComponents = {
  // Prevent block-level wrapping, keep inline flow
  p: ({ children }) => <>{children}</>,
  strong: ({ children }) => <strong className="chat-md-bold">{children}</strong>,
  em: ({ children }) => <em className="chat-md-italic">{children}</em>,
  code: ({ children }) => <code className="chat-md-code">{children}</code>,
  // Disable block elements in chat context
  pre: ({ children }) => <>{children}</>,
  h1: ({ children }) => <strong className="chat-md-bold">{children}</strong>,
  h2: ({ children }) => <strong className="chat-md-bold">{children}</strong>,
  h3: ({ children }) => <strong className="chat-md-bold">{children}</strong>,
  ul: ({ children }) => <span className="chat-md-list">{children}</span>,
  ol: ({ children }) => <span className="chat-md-list">{children}</span>,
  li: ({ children }) => <span className="chat-md-li">• {children} </span>,
  a: ({ href, children }) => (
    <a href={href} className="chat-md-link" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
}

// Render text with markdown support
const ChatMarkdown = ({ children }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={chatMarkdownComponents}
  >
    {children || ''}
  </ReactMarkdown>
)

function Subtitles({
  text = '',
  isTyping = false,
  role = 'assistant',
  history = [],
  currentAssistant = 'quox'
}) {
  const historyRef = useRef(null)
  const [filters, setFilters] = useState({}) // { assistantId: true/false }
  const [showFilters, setShowFilters] = useState(false)
  const assistantOptions = buildAssistantIdentityList(getAllAssistants())

  // Auto-scroll history to bottom when new messages arrive
  useEffect(() => {
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight
    }
  }, [history])

  // Filter messages based on active filters
  const filteredHistory = history.filter(msg => {
    if (msg.role === 'user') return true // Always show user messages
    const assistantId = msg.assistant || 'quox'
    // If no filters set, show all. Otherwise respect filter state
    if (Object.keys(filters).length === 0) return true
    return filters[assistantId] !== false
  })

  // Toggle filter for an assistant
  const toggleFilter = (assistantId) => {
    setFilters(prev => ({
      ...prev,
      [assistantId]: prev[assistantId] === false ? true : false
    }))
  }

  // Get assistant info for a message
  const getAssistantInfo = (msg) => {
    if (msg.role === 'user') return null
    const id = msg.assistant || 'quox'
    return resolveAssistantIdentity(id, { fallbackId: 'quox' })
  }

  // Current assistant info
  const activeAssistant = resolveAssistantIdentity(currentAssistant, { fallbackId: 'quox' })

  return (
    <div className="subtitles-container">
      {/* Header with filter toggle */}
      <div className="conversation-header">
        <span className="header-title">CONVERSATION</span>
        <button
          className={`filter-toggle ${showFilters ? 'active' : ''}`}
          onClick={() => setShowFilters(!showFilters)}
          title="Filter by assistant"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
            <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>
          </svg>
        </button>
      </div>

      {/* Filter chips */}
      {showFilters && (
        <div className="assistant-filters">
          {assistantOptions.map(assistant => (
            <button
              key={assistant.id}
              className={`filter-chip ${filters[assistant.id] === false ? 'inactive' : 'active'}`}
              onClick={() => toggleFilter(assistant.id)}
              style={{
                '--assistant-color': assistant.color,
                '--assistant-rgb': assistant.colorRgb
              }}
            >
              <span className="chip-icon">{assistant.shortName}</span>
              <span className="chip-name">{assistant.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Scrollable conversation history */}
      <div className="conversation-history" ref={historyRef}>
        {filteredHistory.length === 0 ? (
          <div className="history-empty">
            <span>No conversation yet</span>
          </div>
        ) : (
          filteredHistory.slice(-15).map((msg, i) => {
            const assistant = getAssistantInfo(msg)
            return (
              <div
                key={i}
                className={`history-item ${msg.role}`}
                style={assistant ? {
                  '--msg-color': assistant.color,
                  '--msg-rgb': assistant.colorRgb
                } : {}}
              >
                {msg.role === 'user' ? (
                  <span className="history-role user-role">YOU</span>
                ) : (
                  <span className="history-role assistant-role">
                    <span
                      className="assistant-badge"
                      style={{ background: assistant?.color }}
                    >
                      {assistant?.shortName}
                    </span>
                    {assistant?.name}
                  </span>
                )}
                <span className="history-text"><ChatMarkdown>{msg.text}</ChatMarkdown></span>
              </div>
            )
          })
        )}
      </div>

      {/* Current text / status display */}
      <div
        className={`subtitle-text ${role} ${isTyping ? 'typing' : ''}`}
        style={{
          '--active-color': activeAssistant.color,
          '--active-rgb': activeAssistant.colorRgb
        }}
      >
        {isTyping && (
          <span className="typing-indicator">
            <span
              className="assistant-badge"
              style={{ background: activeAssistant.color }}
            >
              {activeAssistant.shortName}
            </span>
            {activeAssistant.name} is thinking...
          </span>
        )}
        {!isTyping && (text ? (
          <ChatMarkdown>{text}</ChatMarkdown>
        ) : (
          <span className="placeholder">
            Press SPACE to speak or type below...
          </span>
        ))}
      </div>
    </div>
  )
}

export default Subtitles
