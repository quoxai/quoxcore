/**
 * QuoxCORE Memory Confirmation Queue
 *
 * Inline chat component for reviewing pending memory confirmations.
 * Part of Wave 2 Memory Overhaul - "giggly-seeking-beacon"
 */

import { useState, useEffect, useCallback } from 'react'
import {
  getConfirmationQueue,
  getCandidateBuffer,
  onQueueChange,
  approveCandidate,
  rejectCandidate,
  approveAll,
  rejectAll,
  getConfirmationStats
} from '../../services/memoryConfirmation.js'
import './memory.css'

/**
 * Compact inline confirmation prompt (shows in chat)
 */
export function MemoryConfirmationInline({ onAction }) {
  const [queue, setQueue] = useState([])
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setQueue(getConfirmationQueue())

    const unsubscribe = onQueueChange(({ queue: newQueue }) => {
      setQueue(newQueue)
    })

    return unsubscribe
  }, [])

  if (queue.length === 0) {
    return null
  }

  const current = queue[0]
  const stats = getConfirmationStats()

  const handleApprove = async () => {
    const result = await approveCandidate(current.id)
    if (onAction) onAction('approved', current, result)
  }

  const handleReject = () => {
    rejectCandidate(current.id, 'User rejected')
    if (onAction) onAction('rejected', current)
  }

  const handleApproveAll = async () => {
    const results = await approveAll()
    if (onAction) onAction('approved_all', null, results)
  }

  const handleRejectAll = () => {
    rejectAll('User rejected all')
    if (onAction) onAction('rejected_all')
  }

  return (
    <div className="memory-confirmation-inline">
      <div className="confirmation-header">
        <span className="confirmation-icon">
          {getSensitivityIcon(current.decision?.sensitivity)}
        </span>
        <span className="confirmation-title">
          Remember this?
        </span>
        {queue.length > 1 && (
          <span className="confirmation-count">
            +{queue.length - 1} more
          </span>
        )}
      </div>

      <div className="confirmation-content">
        <div className="confirmation-text">
          {truncateContent(current.content, 150)}
        </div>
        <div className="confirmation-meta">
          <span className="confirmation-type">{current.type}</span>
          {current.decision?.reasons && (
            <span className="confirmation-reason">
              {current.decision.reasons[0]}
            </span>
          )}
        </div>
      </div>

      <div className="confirmation-actions">
        <button
          className="confirm-btn confirm-approve"
          onClick={handleApprove}
          title="Save to memory"
        >
          Remember
        </button>
        <button
          className="confirm-btn confirm-reject"
          onClick={handleReject}
          title="Don't save"
        >
          Skip
        </button>
        {queue.length > 1 && (
          <>
            <button
              className="confirm-btn confirm-all"
              onClick={handleApproveAll}
              title="Remember all pending"
            >
              All ({queue.length})
            </button>
            <button
              className="confirm-btn confirm-expand"
              onClick={() => setExpanded(!expanded)}
              title="View all pending"
            >
              {expanded ? 'Collapse' : 'View'}
            </button>
          </>
        )}
      </div>

      {expanded && queue.length > 1 && (
        <div className="confirmation-expanded">
          {queue.slice(1).map(item => (
            <ConfirmationItem
              key={item.id}
              item={item}
              onApprove={() => approveCandidate(item.id)}
              onReject={() => rejectCandidate(item.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Single confirmation item in expanded view
 */
function ConfirmationItem({ item, onApprove, onReject }) {
  return (
    <div className="confirmation-item">
      <div className="item-content">
        <span className="item-icon">
          {getSensitivityIcon(item.decision?.sensitivity)}
        </span>
        <span className="item-text">
          {truncateContent(item.content, 100)}
        </span>
        <span className="item-type">{item.type}</span>
      </div>
      <div className="item-actions">
        <button className="item-btn item-approve" onClick={onApprove}>
          +
        </button>
        <button className="item-btn item-reject" onClick={onReject}>
          x
        </button>
      </div>
    </div>
  )
}

/**
 * Full confirmation queue panel (for settings/dedicated view)
 */
export function MemoryConfirmationPanel({ onClose }) {
  const [queue, setQueue] = useState([])
  const [buffer, setBuffer] = useState([])
  const [activeTab, setActiveTab] = useState('pending')
  const [editingId, setEditingId] = useState(null)
  const [editContent, setEditContent] = useState('')

  useEffect(() => {
    setQueue(getConfirmationQueue())
    setBuffer(getCandidateBuffer())

    const unsubscribe = onQueueChange(({ queue: newQueue, buffer: newBuffer }) => {
      setQueue(newQueue)
      setBuffer(newBuffer)
    })

    return unsubscribe
  }, [])

  const stats = getConfirmationStats()

  const handleApprove = async (item) => {
    const options = editingId === item.id ? { editedContent: editContent } : {}
    await approveCandidate(item.id, options)
    setEditingId(null)
  }

  const handleReject = (item) => {
    rejectCandidate(item.id, 'User rejected from panel')
  }

  const startEdit = (item) => {
    setEditingId(item.id)
    setEditContent(item.content)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditContent('')
  }

  return (
    <div className="memory-confirmation-panel">
      <div className="panel-header">
        <h3>Memory Confirmations</h3>
        <div className="panel-stats">
          <span className="stat">
            <strong>{stats.queueLength}</strong> pending
          </span>
          <span className="stat">
            <strong>{stats.bufferLength}</strong> buffered
          </span>
        </div>
        {onClose && (
          <button className="panel-close" onClick={onClose}>x</button>
        )}
      </div>

      <div className="panel-tabs">
        <button
          className={`tab ${activeTab === 'pending' ? 'active' : ''}`}
          onClick={() => setActiveTab('pending')}
        >
          Pending ({queue.length})
        </button>
        <button
          className={`tab ${activeTab === 'buffer' ? 'active' : ''}`}
          onClick={() => setActiveTab('buffer')}
        >
          Buffered ({buffer.length})
        </button>
      </div>

      <div className="panel-content">
        {activeTab === 'pending' && (
          <>
            {queue.length === 0 ? (
              <div className="empty-state">No pending confirmations</div>
            ) : (
              <>
                <div className="bulk-actions">
                  <button onClick={() => approveAll()}>
                    Approve All
                  </button>
                  <button onClick={() => rejectAll()}>
                    Reject All
                  </button>
                </div>

                <div className="items-list">
                  {queue.map(item => (
                    <div key={item.id} className="queue-item">
                      <div className="item-header">
                        <span className={`sensitivity sensitivity-${item.decision?.sensitivity || 'low'}`}>
                          {getSensitivityIcon(item.decision?.sensitivity)}
                          {item.decision?.sensitivity || 'low'}
                        </span>
                        <span className="item-type">{item.type}</span>
                        <span className="item-time">
                          {formatTime(item.queuedAt)}
                        </span>
                      </div>

                      {editingId === item.id ? (
                        <div className="item-edit">
                          <textarea
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            rows={3}
                          />
                          <div className="edit-actions">
                            <button onClick={() => handleApprove(item)}>
                              Save
                            </button>
                            <button onClick={cancelEdit}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="item-content">{item.content}</div>

                          {item.decision?.reasons && (
                            <div className="item-reasons">
                              {item.decision.reasons.map((r, i) => (
                                <span key={i} className="reason">{r}</span>
                              ))}
                            </div>
                          )}
                        </>
                      )}

                      <div className="item-actions">
                        <button
                          className="action-approve"
                          onClick={() => handleApprove(item)}
                        >
                          Approve
                        </button>
                        <button
                          className="action-edit"
                          onClick={() => startEdit(item)}
                        >
                          Edit
                        </button>
                        <button
                          className="action-reject"
                          onClick={() => handleReject(item)}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {activeTab === 'buffer' && (
          <>
            {buffer.length === 0 ? (
              <div className="empty-state">No buffered candidates</div>
            ) : (
              <div className="items-list">
                {buffer.map(item => (
                  <div key={item.id} className="buffer-item">
                    <div className="item-content">{item.content}</div>
                    <div className="item-meta">
                      <span className="item-type">{item.type}</span>
                      <span className="item-confidence">
                        {((item.decision?.confidence || 0) * 100).toFixed(0)}% confidence
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Hook for using confirmation queue in components
 */
export function useMemoryConfirmation() {
  const [queue, setQueue] = useState([])
  const [stats, setStats] = useState(getConfirmationStats())

  useEffect(() => {
    setQueue(getConfirmationQueue())
    setStats(getConfirmationStats())

    const unsubscribe = onQueueChange(({ queue: newQueue }) => {
      setQueue(newQueue)
      setStats(getConfirmationStats())
    })

    return unsubscribe
  }, [])

  const approve = useCallback(async (id, options) => {
    return approveCandidate(id, options)
  }, [])

  const reject = useCallback((id, reason) => {
    return rejectCandidate(id, reason)
  }, [])

  return {
    queue,
    stats,
    hasPending: queue.length > 0,
    approve,
    reject,
    approveAll,
    rejectAll
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function getSensitivityIcon(sensitivity) {
  switch (sensitivity) {
    case 'high': return '\u26a0'  // Warning sign
    case 'medium': return '\u2139'  // Info
    case 'low': return '\u2713'  // Checkmark
    default: return '\u2022'  // Bullet
  }
}

function truncateContent(content, maxLen) {
  if (!content) return ''
  if (content.length <= maxLen) return content
  return content.substring(0, maxLen) + '...'
}

function formatTime(isoString) {
  if (!isoString) return ''
  const date = new Date(isoString)
  const now = new Date()
  const diff = now - date

  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return date.toLocaleDateString()
}

export default MemoryConfirmationInline
