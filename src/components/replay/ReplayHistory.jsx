/**
 * ReplayHistory - List of Replay Sessions
 *
 * Shows history of replay sessions with quick actions for
 * re-running, viewing, and deleting sessions.
 *
 * Part of AOCL Compliance Suite (Enterprise plugin).
 */

import { useState, useEffect } from 'react'
import {
  getReplaySessions,
  deleteReplaySession,
  executeReplay
} from '../../services/replay'
import './replay.css'

export default function ReplayHistory({ onSelectSession, onClose }) {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all') // all, completed, pending, error

  useEffect(() => {
    loadSessions()
  }, [])

  const loadSessions = async () => {
    const allSessions = await getReplaySessions()
    setSessions(allSessions)
  }

  const handleDelete = async (sessionId, e) => {
    e.stopPropagation()
    if (confirm('Delete this replay session?')) {
      await deleteReplaySession(sessionId)
      await loadSessions()
    }
  }

  const handleRerun = async (session, e) => {
    e.stopPropagation()
    setLoading(true)
    setError(null)

    try {
      await executeReplay(session.id)
      loadSessions()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const filteredSessions = sessions.filter(s => {
    if (filter === 'all') return true
    return s.status === filter
  })

  const formatDate = (isoString) => {
    return new Date(isoString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const getStatusBadge = (status) => {
    const badges = {
      pending: { class: 'pending', label: 'Pending' },
      running: { class: 'running', label: 'Running' },
      completed: { class: 'success', label: 'Completed' },
      error: { class: 'error', label: 'Error' }
    }
    return badges[status] || badges.pending
  }

  return (
    <div className="replay-history">
      <div className="replay-history-header">
        <h3>Replay History</h3>
        <div className="replay-history-filters">
          {['all', 'completed', 'pending', 'error'].map(f => (
            <button
              key={f}
              className={`replay-btn-small ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="replay-error">
          {error}
        </div>
      )}

      {loading && (
        <div className="replay-loading">
          <div className="replay-spinner" />
          <span>Re-running replay...</span>
        </div>
      )}

      <div className="replay-history-list">
        {filteredSessions.length === 0 ? (
          <div className="replay-history-empty">
            {filter === 'all'
              ? 'No replay sessions yet. Select a trace to start a replay.'
              : `No ${filter} sessions.`}
          </div>
        ) : (
          filteredSessions.map(session => {
            const badge = getStatusBadge(session.status)

            return (
              <div
                key={session.id}
                className="replay-history-item"
                onClick={() => onSelectSession?.(session)}
              >
                <div className="replay-history-item-main">
                  <div className="replay-history-item-header">
                    <code className="replay-history-id">{session.id}</code>
                    <span className={`replay-badge ${badge.class}`}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="replay-history-item-meta">
                    <span>Original: <code>{session.originalRunId?.slice(0, 16)}...</code></span>
                    <span>{formatDate(session.createdAt)}</span>
                  </div>
                  {session.modifications && (
                    <div className="replay-history-item-mods">
                      {Object.keys(session.modifications.mockResponses || {}).length > 0 && (
                        <span className="replay-mod-badge">
                          {Object.keys(session.modifications.mockResponses).length} mocks
                        </span>
                      )}
                      {Object.values(session.modifications.layerConfig || {}).filter(c => c.enabled === false).length > 0 && (
                        <span className="replay-mod-badge">
                          {Object.values(session.modifications.layerConfig).filter(c => c.enabled === false).length} disabled
                        </span>
                      )}
                      {session.modifications.query !== session.original?.query && (
                        <span className="replay-mod-badge">Query modified</span>
                      )}
                    </div>
                  )}
                </div>
                <div className="replay-history-item-actions">
                  {session.status === 'completed' && (
                    <button
                      className="replay-btn-small"
                      onClick={(e) => handleRerun(session, e)}
                      disabled={loading}
                    >
                      Re-run
                    </button>
                  )}
                  <button
                    className="replay-btn-small danger"
                    onClick={(e) => handleDelete(session.id, e)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {onClose && (
        <div className="replay-history-footer">
          <button className="replay-btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </div>
  )
}
