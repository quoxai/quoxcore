/**
 * ComparisonSelector - Select traces to compare
 *
 * Allows selection of traces and loading saved comparisons.
 * Part of AOCL Compliance Suite.
 */

import { useState, useEffect } from 'react'
import { getConversations } from '../../lib/aee/store'
import './comparison.css'

export default function ComparisonSelector({
  savedComparisons = [],
  onCompare,
  onLoadComparison,
  onDeleteComparison
}) {
  const [conversations, setConversations] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('select') // select, saved

  // Load recent conversations
  useEffect(() => {
    loadConversations()
  }, [])

  const loadConversations = async () => {
    setLoading(true)
    try {
      const convs = await getConversations({ limit: 30 })
      // Filter to only show chat conversations (not AOCL events)
      const chatConvs = convs.filter(c =>
        c.firstMessage?.intent === 'quox.chat.query'
      )
      setConversations(chatConvs)
    } catch (err) {
      console.error('Failed to load conversations:', err)
    } finally {
      setLoading(false)
    }
  }

  const toggleSelection = (corr) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(corr)) {
        next.delete(corr)
      } else {
        next.add(corr)
      }
      return next
    })
  }

  const handleCompare = () => {
    if (selected.size >= 2) {
      onCompare(Array.from(selected))
    }
  }

  const formatTime = (ts) => {
    const date = new Date(ts)
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const getQueryPreview = (conv) => {
    const text = conv.firstMessage?.payload?.text || ''
    return text.length > 60 ? text.slice(0, 57) + '...' : text
  }

  return (
    <div className="comparison-selector">
      {/* Tabs */}
      <div className="comparison-selector-tabs">
        <button
          className={tab === 'select' ? 'active' : ''}
          onClick={() => setTab('select')}
        >
          Select Traces
        </button>
        <button
          className={tab === 'saved' ? 'active' : ''}
          onClick={() => setTab('saved')}
        >
          Saved Comparisons ({savedComparisons.length})
        </button>
      </div>

      {/* Select Traces Tab */}
      {tab === 'select' && (
        <div className="comparison-selector-select">
          <div className="comparison-selector-header">
            <span>Select 2 or more traces to compare</span>
            <span className="comparison-selector-count">
              {selected.size} selected
            </span>
          </div>

          {loading ? (
            <div className="comparison-selector-loading">Loading conversations...</div>
          ) : conversations.length === 0 ? (
            <div className="comparison-selector-empty">
              No conversations found. Start chatting to create traces.
            </div>
          ) : (
            <div className="comparison-selector-list">
              {conversations.map(conv => (
                <div
                  key={conv.corr}
                  className={`comparison-selector-item ${selected.has(conv.corr) ? 'selected' : ''}`}
                  onClick={() => toggleSelection(conv.corr)}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(conv.corr)}
                    onChange={() => toggleSelection(conv.corr)}
                    onClick={e => e.stopPropagation()}
                  />
                  <div className="comparison-selector-item-content">
                    <span className="comparison-selector-query">
                      {getQueryPreview(conv)}
                    </span>
                    <div className="comparison-selector-meta">
                      <code>{conv.corr.slice(0, 16)}...</code>
                      <span>{formatTime(conv.firstMessage?.ts)}</span>
                      <span>{conv.count} msgs</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="comparison-selector-actions">
            <button
              className="comparison-btn-secondary"
              onClick={() => setSelected(new Set())}
              disabled={selected.size === 0}
            >
              Clear Selection
            </button>
            <button
              className="comparison-btn-primary"
              onClick={handleCompare}
              disabled={selected.size < 2}
            >
              Compare {selected.size} Traces
            </button>
          </div>
        </div>
      )}

      {/* Saved Comparisons Tab */}
      {tab === 'saved' && (
        <div className="comparison-selector-saved">
          {savedComparisons.length === 0 ? (
            <div className="comparison-selector-empty">
              No saved comparisons yet. Create a comparison to save it.
            </div>
          ) : (
            <div className="comparison-selector-list">
              {savedComparisons.map(comp => (
                <div
                  key={comp.id}
                  className="comparison-selector-item saved"
                  onClick={() => onLoadComparison(comp)}
                >
                  <div className="comparison-selector-item-content">
                    <span className="comparison-selector-name">
                      {comp.name}
                    </span>
                    <div className="comparison-selector-meta">
                      <span>{comp.traces.length} traces</span>
                      <span>{comp.similarity}% similar</span>
                      <span>{formatTime(comp.createdAt)}</span>
                    </div>
                    <div className="comparison-selector-traces">
                      {comp.traces.map((t, idx) => (
                        <code key={t.corr}>
                          {idx > 0 && ' vs '}
                          {t.corr.slice(0, 8)}...
                        </code>
                      ))}
                    </div>
                  </div>
                  <button
                    className="comparison-selector-delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteComparison(comp.id)
                    }}
                    title="Delete comparison"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
