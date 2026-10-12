/**
 * Conversation Archive — Browse and search imported AI conversations
 *
 * Three views:
 * 1. List — filterable, searchable list of all archived conversations
 * 2. Viewer — full thread view of a single conversation
 * 3. Stats banner — counts by platform, total messages, date range
 */

import { useState, useEffect, useCallback } from 'react'
import MarkdownContent from '../ui/MarkdownContent'
import { getMemoryClient } from '../../services/memoryClient'
import './memory.css'

// Platform badge config
const PLATFORMS = {
  chatgpt: { label: 'ChatGPT', color: '#10a37f' },
  claude: { label: 'Claude', color: '#d97706' },
  gemini: { label: 'Gemini', color: '#4285f4' },
  perplexity: { label: 'Perplexity', color: '#20b2aa' },
  quox: { label: 'QuoxCORE', color: '#38bdf8' }
}

/**
 * Main ConversationArchive component
 */
export function ConversationArchive() {
  const [view, setView] = useState('list') // 'list' | 'viewer'
  const [conversations, setConversations] = useState([])
  const [selectedConversation, setSelectedConversation] = useState(null)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [platformFilter, setPlatformFilter] = useState('')
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(true)

  const PAGE_SIZE = 50

  // Load stats on mount
  useEffect(() => {
    loadStats()
  }, [])

  // Load conversations when filters change
  useEffect(() => {
    setPage(0)
    setConversations([])
    loadConversations(0)
  }, [platformFilter])

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery.trim()) {
        performSearch(searchQuery)
      } else {
        setPage(0)
        setConversations([])
        loadConversations(0)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const loadStats = async () => {
    try {
      const client = getMemoryClient()
      const s = await client.getConversationStats()
      setStats(s)
    } catch (err) {
      console.error('Failed to load conversation stats:', err)
    }
  }

  const loadConversations = useCallback(async (pageOffset) => {
    setLoading(true)
    try {
      const client = getMemoryClient()
      const result = await client.getConversations({
        platform: platformFilter || undefined,
        limit: PAGE_SIZE,
        offset: pageOffset * PAGE_SIZE
      })
      if (pageOffset === 0) {
        setConversations(result)
      } else {
        setConversations(prev => [...prev, ...result])
      }
      setHasMore(result.length === PAGE_SIZE)
    } catch (err) {
      console.error('Failed to load conversations:', err)
    }
    setLoading(false)
  }, [platformFilter])

  const performSearch = async (query) => {
    setLoading(true)
    try {
      const client = getMemoryClient()
      const results = await client.searchConversations(query, {
        platform: platformFilter || undefined,
        limit: PAGE_SIZE
      })
      setConversations(results)
      setHasMore(false)
    } catch (err) {
      console.error('Search failed:', err)
    }
    setLoading(false)
  }

  const openConversation = async (conv) => {
    setLoading(true)
    try {
      const client = getMemoryClient()
      const full = await client.getConversation(conv.id)
      setSelectedConversation(full)
      setView('viewer')
    } catch (err) {
      console.error('Failed to load conversation:', err)
    }
    setLoading(false)
  }

  const goBack = () => {
    setView('list')
    setSelectedConversation(null)
  }

  const loadMore = () => {
    const nextPage = page + 1
    setPage(nextPage)
    loadConversations(nextPage)
  }

  if (view === 'viewer' && selectedConversation) {
    return <ConversationViewer conversation={selectedConversation} onBack={goBack} />
  }

  return (
    <div className="conv-archive">
      {/* Stats Banner */}
      {stats && stats.conversations > 0 && (
        <div className="conv-stats-banner">
          <div className="conv-stat">
            <span className="conv-stat-value">{stats.conversations.toLocaleString()}</span>
            <span className="conv-stat-label">Conversations</span>
          </div>
          <div className="conv-stat">
            <span className="conv-stat-value">{stats.messages.toLocaleString()}</span>
            <span className="conv-stat-label">Messages</span>
          </div>
          {Object.entries(stats.by_platform || {}).map(([platform, count]) => (
            <div key={platform} className="conv-stat">
              <span className="conv-stat-value">{count.toLocaleString()}</span>
              <span className="conv-stat-label" style={{ color: PLATFORMS[platform]?.color || '#888' }}>
                {PLATFORMS[platform]?.label || platform}
              </span>
            </div>
          ))}
          {stats.date_range?.earliest && (
            <div className="conv-stat">
              <span className="conv-stat-value">
                {new Date(stats.date_range.earliest).toLocaleDateString()} — {new Date(stats.date_range.latest).toLocaleDateString()}
              </span>
              <span className="conv-stat-label">Date Range</span>
            </div>
          )}
        </div>
      )}

      {/* Filter Bar */}
      <div className="conv-filter-bar">
        <div className="conv-search-box">
          <span className="conv-search-icon">O</span>
          <input
            type="text"
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="conv-search-input"
          />
          {searchQuery && (
            <button className="conv-search-clear" onClick={() => setSearchQuery('')}>x</button>
          )}
        </div>
        <select
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value)}
          className="conv-platform-filter"
        >
          <option value="">All Platforms</option>
          {Object.entries(PLATFORMS).map(([key, { label }]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>

      {/* Conversation List */}
      {loading && conversations.length === 0 ? (
        <div className="conv-loading">
          <div className="loading-spinner" />
          <p>Loading conversations...</p>
        </div>
      ) : conversations.length === 0 ? (
        <div className="conv-empty">
          <p className="conv-empty-title">No conversations found</p>
          <p className="conv-empty-desc">
            {searchQuery
              ? 'Try a different search term'
              : 'Import conversations from the Import panel to see them here'}
          </p>
        </div>
      ) : (
        <div className="conv-list">
          {conversations.map((conv) => (
            <button
              key={conv.id}
              className="conv-card"
              onClick={() => openConversation(conv)}
            >
              <div className="conv-card-header">
                <span
                  className="conv-platform-badge"
                  style={{ backgroundColor: PLATFORMS[conv.platform]?.color || '#888' }}
                >
                  {PLATFORMS[conv.platform]?.label || conv.platform}
                </span>
                <span className="conv-card-date">
                  {conv.first_message_at
                    ? new Date(conv.first_message_at).toLocaleDateString()
                    : conv.created_at
                      ? new Date(conv.created_at).toLocaleDateString()
                      : ''}
                </span>
              </div>
              <h4 className="conv-card-title">{conv.title || 'Untitled'}</h4>
              <div className="conv-card-meta">
                <span className="conv-card-count">{conv.message_count} messages</span>
                {conv.topics && conv.topics.length > 0 && (
                  <div className="conv-card-topics">
                    {conv.topics.slice(0, 3).map((topic, i) => (
                      <span key={i} className="conv-topic-tag">{topic}</span>
                    ))}
                    {conv.topics.length > 3 && (
                      <span className="conv-topic-more">+{conv.topics.length - 3}</span>
                    )}
                  </div>
                )}
              </div>
            </button>
          ))}

          {hasMore && !searchQuery && (
            <button className="conv-load-more" onClick={loadMore} disabled={loading}>
              {loading ? 'Loading...' : 'Load More'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Conversation Viewer — full thread display
 */
function ConversationViewer({ conversation, onBack }) {
  if (!conversation) return null

  const { title, platform, message_count, first_message_at, last_message_at, topics, messages, metadata } = conversation
  const platformInfo = PLATFORMS[platform] || { label: platform, color: '#888' }

  return (
    <div className="conv-viewer">
      {/* Header */}
      <div className="conv-viewer-header">
        <button className="conv-back-btn" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <div className="conv-viewer-info">
          <h3 className="conv-viewer-title">{title || 'Untitled'}</h3>
          <div className="conv-viewer-meta">
            <span className="conv-platform-badge" style={{ backgroundColor: platformInfo.color }}>
              {platformInfo.label}
            </span>
            {first_message_at && (
              <span className="conv-viewer-date">
                {new Date(first_message_at).toLocaleDateString()}
                {last_message_at && first_message_at !== last_message_at && (
                  <> — {new Date(last_message_at).toLocaleDateString()}</>
                )}
              </span>
            )}
            <span className="conv-viewer-count">{message_count} messages</span>
            {metadata?.model && (
              <span className="conv-viewer-model">{metadata.model}</span>
            )}
          </div>
          {topics && topics.length > 0 && (
            <div className="conv-viewer-topics">
              {topics.map((topic, i) => (
                <span key={i} className="conv-topic-tag">{topic}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Thread */}
      <div className="conv-thread">
        {(messages || []).map((msg, idx) => (
          <div key={idx} className={`conv-message conv-message-${msg.role}`}>
            <div className="conv-message-header">
              <span className="conv-message-role">
                {msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'AI' : msg.role}
              </span>
              {msg.created_at && (
                <span className="conv-message-time">
                  {new Date(msg.created_at).toLocaleString()}
                </span>
              )}
              {msg.model && (
                <span className="conv-message-model">{msg.model}</span>
              )}
            </div>
            <div className="conv-message-content">
              <MarkdownContent compact>{msg.content}</MarkdownContent>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default ConversationArchive
