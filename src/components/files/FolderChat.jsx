/**
 * FolderChat Component
 *
 * Chat interface scoped to folder contents:
 * - Chat with files in a specific folder
 * - Grounded responses with citations
 * - Include subfolders toggle
 * - File preview on citation click
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  buildFolderContext,
  generateGroundedPrompt,
  formatWithCitations,
  getFolderChatStatus,
  canUseSemanticSearch
} from '../../services/scopedChatService'
import { getFolder, getFile } from '../../services/fileStorage'
import {
  getFolderPersonality,
  setFolderInstructions,
  generateFolderPersonality
} from '../../services/folderPersonality'
import { CitationBlock } from '../chat/CitationBlock'
import './folder-chat.css'

// Markdown components for folder chat
const mdComponents = {
  p: ({ children }) => <p className="fc-md-p">{children}</p>,
  strong: ({ children }) => <strong className="fc-md-bold">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  code: ({ inline, children }) => inline
    ? <code className="fc-md-code">{children}</code>
    : <pre className="fc-md-pre"><code>{children}</code></pre>,
  ul: ({ children }) => <ul className="fc-md-list">{children}</ul>,
  ol: ({ children }) => <ol className="fc-md-list fc-md-ol">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
}

/**
 * Message component
 */
function ChatMessage({ message, onCitationClick }) {
  const isUser = message.role === 'user'

  return (
    <div className={`fc-message ${isUser ? 'user' : 'assistant'}`}>
      <div className="fc-message-avatar">
        {isUser ? (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
        )}
      </div>
      <div className="fc-message-content">
        {isUser ? (
          <p>{message.content}</p>
        ) : message.citations?.length > 0 ? (
          <CitationBlock
            text={message.content}
            citations={message.citations}
            onCitationClick={onCitationClick}
          />
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {message.content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  )
}

/**
 * File preview modal
 */
function FilePreviewModal({ file, onClose }) {
  const [content, setContent] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (file) {
      const fileData = getFile(file.id)
      setContent(fileData?.data || null)
      setLoading(false)
    }
  }, [file])

  if (!file) return null

  const isImage = file.category === 'image' || file.type?.startsWith('image/')

  return (
    <div className="fc-preview-overlay" onClick={onClose}>
      <div className="fc-preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fc-preview-header">
          <h3>{file.name}</h3>
          <button className="fc-preview-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div className="fc-preview-body">
          {loading ? (
            <p>Loading...</p>
          ) : isImage && content ? (
            <img src={content} alt={file.name} />
          ) : content ? (
            <pre>{atob(content.split(',')[1])}</pre>
          ) : (
            <p>Unable to load file content</p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Main FolderChat Component
 */
export function FolderChat({
  folderPath = '/',
  onClose,
  onFolderChange
}) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [includeSubfolders, setIncludeSubfolders] = useState(false)
  const [previewFile, setPreviewFile] = useState(null)
  const [status, setStatus] = useState(null)
  const [showPersonality, setShowPersonality] = useState(false)
  const [personality, setPersonality] = useState(null)
  const [customInstructions, setCustomInstructions] = useState('')
  const [savingInstructions, setSavingInstructions] = useState(false)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  // Get folder info
  const folder = getFolder(folderPath)

  // Load folder status and personality
  useEffect(() => {
    const chatStatus = getFolderChatStatus(folderPath)
    setStatus(chatStatus)

    // Load folder personality
    const folderPersonality = getFolderPersonality(folderPath)
    setPersonality(folderPersonality)
    setCustomInstructions(folderPersonality?.customInstructions || '')

    // Generate personality if needed
    if (!folderPersonality) {
      generateFolderPersonality(folderPath).then(p => {
        setPersonality(p)
        setCustomInstructions(p?.customInstructions || '')
      }).catch(console.warn)
    }
  }, [folderPath])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Handle send message
  const handleSend = useCallback(async () => {
    if (!input.trim() || loading) return

    const userMessage = input.trim()
    setInput('')
    setLoading(true)

    // Add user message
    setMessages(prev => [...prev, {
      id: Date.now(),
      role: 'user',
      content: userMessage
    }])

    try {
      // Build folder context
      const context = await buildFolderContext(folderPath, {
        recursive: includeSubfolders,
        query: userMessage
      })

      if (context.isEmpty) {
        setMessages(prev => [...prev, {
          id: Date.now() + 1,
          role: 'assistant',
          content: `This folder is empty. Upload some files to start chatting about them.`,
          citations: []
        }])
        setLoading(false)
        return
      }

      // Generate grounded prompt
      const prompt = generateGroundedPrompt(userMessage, context)

      // For now, simulate AI response (in production, call Claude API)
      // This is a placeholder that demonstrates the citation format
      const simulatedResponse = generateSimulatedResponse(userMessage, context)

      // Format response with citations
      const formatted = formatWithCitations(
        simulatedResponse.text,
        simulatedResponse.usedRefs,
        context.references
      )

      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'assistant',
        content: formatted.text,
        citations: formatted.citations
      }])

    } catch (err) {
      console.error('Chat error:', err)
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'assistant',
        content: `Sorry, I encountered an error: ${err.message}`,
        citations: []
      }])
    }

    setLoading(false)
  }, [input, loading, folderPath, includeSubfolders])

  // Handle key press
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Handle citation click
  const handleCitationClick = (citation) => {
    setPreviewFile(citation)
  }

  // Handle saving custom instructions
  const handleSaveInstructions = async () => {
    setSavingInstructions(true)
    try {
      const updated = setFolderInstructions(folderPath, customInstructions)
      setPersonality(prev => ({ ...prev, ...updated }))
    } catch (err) {
      console.error('Failed to save instructions:', err)
    }
    setSavingInstructions(false)
  }

  // Refresh personality
  const handleRefreshPersonality = async () => {
    const p = await generateFolderPersonality(folderPath, { forceRefresh: true })
    setPersonality(p)
    setCustomInstructions(p?.customInstructions || '')
  }

  return (
    <div className="folder-chat">
      {/* Header */}
      <div className="fc-header">
        <div className="fc-header-info">
          <span className="fc-folder-icon">{folder?.icon || '📁'}</span>
          <div className="fc-header-text">
            <h3>Chat with {folder?.name || 'Folder'}</h3>
            <span className="fc-file-count">
              {status?.textFiles || 0} searchable file{status?.textFiles !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        <div className="fc-header-actions">
          <label className="fc-toggle">
            <input
              type="checkbox"
              checked={includeSubfolders}
              onChange={(e) => setIncludeSubfolders(e.target.checked)}
            />
            <span>Include subfolders</span>
          </label>

          <button
            className={`fc-settings-btn ${showPersonality ? 'active' : ''}`}
            onClick={() => setShowPersonality(!showPersonality)}
            title="Folder personality settings"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
            </svg>
          </button>

          {onClose && (
            <button className="fc-close" onClick={onClose}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Personality Settings Panel */}
      {showPersonality && (
        <div className="fc-personality-panel">
          <div className="fc-personality-header">
            <h4>Folder Personality</h4>
            <button
              className="fc-refresh-btn"
              onClick={handleRefreshPersonality}
              title="Regenerate personality"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 11-6.22-8.56"/><path d="M21 3v6h-6"/>
              </svg>
            </button>
          </div>

          {personality?.summary && (
            <div className="fc-personality-summary">
              <p>{personality.summary}</p>
            </div>
          )}

          {personality?.topics?.length > 0 && (
            <div className="fc-personality-topics">
              <span className="fc-topics-label">Topics:</span>
              <div className="fc-topics-list">
                {personality.topics.slice(0, 6).map((topic, i) => (
                  <span key={i} className="fc-topic-tag">{topic}</span>
                ))}
              </div>
            </div>
          )}

          <div className="fc-custom-instructions">
            <label>Custom Instructions</label>
            <textarea
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              placeholder="Add special instructions for how the AI should respond when chatting with this folder..."
              rows={3}
            />
            <button
              className="fc-save-instructions"
              onClick={handleSaveInstructions}
              disabled={savingInstructions}
            >
              {savingInstructions ? 'Saving...' : 'Save Instructions'}
            </button>
          </div>
        </div>
      )}

      {/* Status banner */}
      {status?.premiumRequired && (
        <div className="fc-premium-banner">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          <span>Semantic search requires Advanced Memory plugin</span>
        </div>
      )}

      {/* Messages */}
      <div className="fc-messages">
        {messages.length === 0 ? (
          <div className="fc-empty">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
            <h4>Ask about your files</h4>
            <p>I can answer questions based on the files in this folder.</p>
            <div className="fc-suggestions">
              <button onClick={() => setInput('Summarize the main topics in these files')}>
                Summarize main topics
              </button>
              <button onClick={() => setInput('What information is in these files?')}>
                What's in these files?
              </button>
            </div>
          </div>
        ) : (
          messages.map(msg => (
            <ChatMessage
              key={msg.id}
              message={msg}
              onCitationClick={handleCitationClick}
            />
          ))
        )}

        {loading && (
          <div className="fc-message assistant loading">
            <div className="fc-message-avatar">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <div className="fc-message-content">
              <div className="fc-typing">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="fc-input-area">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder="Ask about files in this folder..."
          disabled={loading || !status?.canChat}
          rows={1}
        />
        <button
          className="fc-send"
          onClick={handleSend}
          disabled={!input.trim() || loading || !status?.canChat}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>

      {/* File preview modal */}
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  )
}

/**
 * Simulate an AI response (placeholder for actual Claude API call)
 */
function generateSimulatedResponse(query, context) {
  const queryLower = query.toLowerCase()

  // Find relevant files based on simple keyword matching
  const relevantRefs = context.references.filter(ref => {
    const nameLower = ref.name.toLowerCase()
    return queryLower.split(/\s+/).some(term =>
      term.length > 2 && nameLower.includes(term)
    )
  })

  // If we found relevant files
  if (relevantRefs.length > 0) {
    const refMarkers = relevantRefs.slice(0, 3).map(r => `[${r.index}]`).join(', ')
    return {
      text: `Based on the files in this folder, I found relevant information in ${refMarkers}. The files contain content related to your query about "${query}". For more specific answers, please ensure the AI backend is connected.`,
      usedRefs: relevantRefs.slice(0, 3).map(r => r.index)
    }
  }

  // Generic response
  if (context.references.length > 0) {
    return {
      text: `I have access to ${context.references.length} file(s) in this folder. To provide specific answers about "${query}", I would need to analyze the content more deeply. Currently showing a demo response - connect the Claude API for full functionality.`,
      usedRefs: []
    }
  }

  return {
    text: `I don't have any files to reference in this folder. Please upload some files first.`,
    usedRefs: []
  }
}

export default FolderChat
