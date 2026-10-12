/**
 * ArchivistPanel Component
 *
 * Dedicated ARCHIVIST chat panel for the Files page:
 * - Always visible on right side of Files page
 * - Scoped to current folder (or all files if root)
 * - Integrated skills (summarize, compare, extract)
 * - Citations that link to file previews
 * - Real Claude API integration via scopedChatService
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  buildFolderContext,
  generateGroundedPrompt,
  formatWithCitations,
  searchFolderFiles,
  canUseSemanticSearch
} from '../../services/scopedChatService'
import { listFiles, getFile, getFolderTree } from '../../services/fileStorage'
import { isPremiumFilesAvailable } from '../../services/fileMemoryBridge'
import {
  FILE_SKILLS,
  isFileOpsAvailable,
  getAvailableSkills,
  executeSkill
} from '../../services/fileOpsAgent'
import { CitationBlock } from '../chat/CitationBlock'
import './archivist-panel.css'

// GTM-A1/B1: was '/webhook', which nginx never routed for /chat: the POST fell
// through to the SPA static handler and came back as a 405 HTML page.
const API_BASE = '/collector'

/**
 * Skill button component
 */
function SkillButton({ skill, onClick, disabled, count }) {
  const icons = {
    summarize: <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></>,
    compare: <><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></>,
    extract: <><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></>,
    analyze: <><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>
  }

  return (
    <button
      className={`ap-skill-btn ${disabled ? 'disabled' : ''}`}
      onClick={() => !disabled && onClick(skill)}
      disabled={disabled}
      title={skill.description}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {icons[skill.id] || icons.summarize}
      </svg>
      <span>{skill.name}</span>
      {count > 0 && <span className="ap-skill-count">{count}</span>}
    </button>
  )
}

/**
 * Chat message component
 */
function ChatMessage({ message, onCitationClick }) {
  const isUser = message.role === 'user'

  return (
    <div className={`ap-message ${isUser ? 'user' : 'assistant'}`}>
      <div className="ap-message-avatar">
        {isUser ? (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
        )}
      </div>
      <div className="ap-message-content">
        {isUser ? (
          <p>{message.content}</p>
        ) : message.citations?.length > 0 ? (
          <CitationBlock
            text={message.content}
            citations={message.citations}
            onCitationClick={onCitationClick}
          />
        ) : (
          <p>{message.content}</p>
        )}
        {message.skillResult && (
          <div className="ap-skill-result">
            <span className="ap-skill-badge">{message.skillResult}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Main ArchivistPanel Component
 */
export function ArchivistPanel({
  folderPath = '/',
  selectedFiles = [],
  allFiles = [],
  onFileClick,
  onScopeChange
}) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [currentScope, setCurrentScope] = useState(folderPath)
  const [showScopeDropdown, setShowScopeDropdown] = useState(false)
  const [skillLoading, setSkillLoading] = useState(null)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  // Get folder tree for scope selector
  const folderTree = getFolderTree()

  // Get file count for current scope
  const scopedFiles = listFiles({ folderPath: currentScope, recursive: true })
  const fileCount = scopedFiles.length

  // Available skills based on selection
  const availableSkills = selectedFiles.length > 0
    ? getAvailableSkills(selectedFiles.length)
    : []

  // Update scope when folder changes externally
  useEffect(() => {
    if (folderPath !== currentScope) {
      setCurrentScope(folderPath)
    }
  }, [folderPath])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Add a message
  const addMessage = useCallback((msg) => {
    setMessages(prev => [...prev, { id: Date.now(), ...msg }])
  }, [])

  // Handle send message
  const handleSend = useCallback(async () => {
    if (!input.trim() || loading) return

    const userMessage = input.trim()
    setInput('')
    setLoading(true)

    // Add user message
    addMessage({ role: 'user', content: userMessage })

    try {
      // Build folder context (scoped to current folder only)
      const context = await buildFolderContext(currentScope, {
        recursive: true,
        query: userMessage
      })

      if (context.isEmpty) {
        addMessage({
          role: 'assistant',
          content: currentScope === '/'
            ? 'You have no files uploaded yet. Upload some files to start chatting about them.'
            : `The folder "${currentScope}" is empty. Select a different folder or upload some files.`,
          citations: []
        })
        setLoading(false)
        return
      }

      // Generate grounded prompt
      const systemPrompt = generateGroundedPrompt(userMessage, context)

      // Add ARCHIVIST-specific context
      const archivistContext = `## ARCHIVIST - File Operations Specialist

You are ARCHIVIST, the file operations specialist. You have access ONLY to files in the user's QuoxCORE Files storage.

### Current Scope
- Folder: ${currentScope === '/' ? 'All Files' : currentScope}
- Files in scope: ${context.fileCount}
- Subfolders included: Yes

### Important Rules
- You can ONLY see files in the current scope (${currentScope} and subfolders)
- You cannot see files in parent folders or sibling folders
- These are browser localStorage files, NOT server filesystem files
- Always cite sources using [1], [2], etc.

${systemPrompt}`

      // Call Claude API
      const response = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userMessage,
          selected_agent: 'archivist',
          quox_context: archivistContext
        })
      })

      const data = await response.json()
      const responseText = data.result || data.error || 'No response received.'

      // Format response with citations
      const formatted = formatWithCitations(responseText, [], context.references)

      addMessage({
        role: 'assistant',
        content: formatted.text,
        citations: formatted.citations
      })

    } catch (err) {
      console.error('[ArchivistPanel] Chat error:', err)
      addMessage({
        role: 'assistant',
        content: `Sorry, I encountered an error: ${err.message}`,
        citations: []
      })
    }

    setLoading(false)
  }, [input, loading, currentScope, addMessage])

  // Handle key press
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Handle skill execution
  const handleSkill = useCallback(async (skill) => {
    if (selectedFiles.length === 0 || skillLoading) return

    setSkillLoading(skill.id)

    try {
      // Get full file data for selected files
      const filesData = selectedFiles.map(id => {
        const file = allFiles.find(f => f.id === id)
        if (!file) return null
        const fullFile = getFile(id)
        return fullFile ? { ...file, ...fullFile } : file
      }).filter(Boolean)

      // Execute the skill
      const result = await executeSkill(skill.id, filesData)

      if (result.error) {
        addMessage({
          role: 'assistant',
          content: result.message || `Failed to ${skill.name.toLowerCase()}.`,
          skillResult: `${skill.name} Failed`
        })
      } else {
        // Format result as chat message
        let content = ''
        if (result.summary) content += result.summary + '\n\n'
        if (result.keyPoints?.length > 0) {
          content += '**Key Points:**\n' + result.keyPoints.map(p => `- ${p}`).join('\n') + '\n\n'
        }
        if (result.differences?.length > 0) {
          content += '**Differences:**\n' + result.differences.map(d => `- ${d}`).join('\n') + '\n\n'
        }
        if (result.extractedData) {
          content += '**Extracted Data:**\n```json\n' + JSON.stringify(result.extractedData, null, 2) + '\n```'
        }

        // Build citations from files
        const citations = filesData.map((f, i) => ({
          index: i + 1,
          id: f.id,
          name: f.name,
          type: f.type,
          size: f.size
        }))

        addMessage({
          role: 'assistant',
          content: content || `${skill.name} completed.`,
          citations,
          skillResult: skill.name
        })
      }
    } catch (err) {
      console.error('[ArchivistPanel] Skill error:', err)
      addMessage({
        role: 'assistant',
        content: `Error executing ${skill.name}: ${err.message}`,
        skillResult: `${skill.name} Error`
      })
    }

    setSkillLoading(null)
  }, [selectedFiles, allFiles, skillLoading, addMessage])

  // Handle citation click
  const handleCitationClick = (citation) => {
    if (onFileClick) {
      const file = allFiles.find(f => f.id === citation.id) || citation
      onFileClick(file)
    }
  }

  // Handle scope change
  const handleScopeChange = (path) => {
    setCurrentScope(path)
    setShowScopeDropdown(false)
    if (onScopeChange) onScopeChange(path)
  }

  // Clear chat
  const clearChat = () => {
    setMessages([])
  }

  // Flatten folder tree for dropdown
  const flattenFolders = (node, depth = 0, result = []) => {
    result.push({ path: node.path || '/', name: node.name, depth })
    if (node.children) {
      node.children.forEach(child => flattenFolders(child, depth + 1, result))
    }
    return result
  }
  const folders = flattenFolders(folderTree)

  return (
    <div className="archivist-panel">
      {/* Header */}
      <div className="ap-header">
        <div className="ap-header-title">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
          <span>ARCHIVIST</span>
        </div>

        <div className="ap-header-actions">
          <button
            className="ap-clear-btn"
            onClick={clearChat}
            title="Clear chat"
            disabled={messages.length === 0}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Scope Selector */}
      <div className="ap-scope">
        <div className="ap-scope-label">Scope:</div>
        <div className="ap-scope-selector">
          <button
            className="ap-scope-btn"
            onClick={() => setShowScopeDropdown(!showScopeDropdown)}
          >
            <span className="ap-scope-path">
              {currentScope === '/' ? 'All Files' : currentScope}
            </span>
            <span className="ap-scope-count">({fileCount} files)</span>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6"/>
            </svg>
          </button>

          {showScopeDropdown && (
            <div className="ap-scope-dropdown">
              {folders.map(folder => (
                <button
                  key={folder.path}
                  className={`ap-scope-option ${folder.path === currentScope ? 'selected' : ''}`}
                  onClick={() => handleScopeChange(folder.path)}
                  style={{ paddingLeft: `${12 + folder.depth * 16}px` }}
                >
                  {folder.path === '/' ? 'All Files' : folder.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Premium Badge */}
      {!isPremiumFilesAvailable() && (
        <div className="ap-premium-badge">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          <span>Keyword search only</span>
        </div>
      )}

      {/* Messages */}
      <div className="ap-messages">
        {messages.length === 0 ? (
          <div className="ap-empty">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
            <h4>Ask ARCHIVIST</h4>
            <p>
              {fileCount > 0
                ? `I can answer questions about your ${fileCount} file${fileCount !== 1 ? 's' : ''} in ${currentScope === '/' ? 'your storage' : currentScope}.`
                : 'Upload some files to start chatting.'}
            </p>
          </div>
        ) : (
          <>
            {messages.map(msg => (
              <ChatMessage
                key={msg.id}
                message={msg}
                onCitationClick={handleCitationClick}
              />
            ))}
            {loading && (
              <div className="ap-message assistant loading">
                <div className="ap-message-avatar">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
                  </svg>
                </div>
                <div className="ap-message-content">
                  <div className="ap-typing">
                    <span></span><span></span><span></span>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="ap-input-area">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder={fileCount > 0 ? 'Ask about your files...' : 'Upload files to chat'}
          disabled={loading || fileCount === 0}
          rows={1}
        />
        <button
          className="ap-send-btn"
          onClick={handleSend}
          disabled={!input.trim() || loading || fileCount === 0}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>

      {/* Skills Section */}
      <div className="ap-skills">
        <div className="ap-skills-header">
          <span className="ap-skills-label">Skills</span>
          {selectedFiles.length > 0 && (
            <span className="ap-skills-selected">{selectedFiles.length} selected</span>
          )}
        </div>
        <div className="ap-skills-buttons">
          {Object.values(FILE_SKILLS).slice(0, 4).map(skill => {
            const isAvailable = availableSkills.some(s => s.id === skill.id)
            const isLoading = skillLoading === skill.id
            return (
              <SkillButton
                key={skill.id}
                skill={skill}
                onClick={handleSkill}
                disabled={!isAvailable || isLoading || !isFileOpsAvailable()}
                count={isLoading ? null : (isAvailable ? selectedFiles.length : 0)}
              />
            )
          })}
        </div>
        {selectedFiles.length === 0 && (
          <p className="ap-skills-hint">Select files above to use skills</p>
        )}
      </div>
    </div>
  )
}

export default ArchivistPanel
