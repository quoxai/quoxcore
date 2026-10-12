/**
 * Admin Feedback Page
 * View, filter, and manage user feedback submissions
 */

import { useState, useEffect, useCallback } from 'react'
import { getFeedback, updateFeedbackStatus, deleteFeedback } from '../../services/feedbackClient'
import { RefreshCw, MessageSquare } from 'lucide-react'

const STATUSES = ['all', 'unread', 'read', 'archived']
const TYPES = ['all', 'feedback', 'bug', 'feature', 'integration_request']
const TYPE_LABELS = { feedback: 'Feedback', bug: 'Bug Report', feature: 'Feature Request', integration_request: 'Integration' }

export default function AdminFeedback() {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filters, setFilters] = useState({ status: 'all', type: 'all' })
  const [expandedId, setExpandedId] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getFeedback({ ...filters, page })
      setItems(data.items || [])
      setTotal(data.total || 0)
      setPages(data.pages || 1)
      setLoading(false)
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }, [filters, page])

  useEffect(() => { fetchData() }, [fetchData])

  const handleRefresh = async () => {
    setRefreshing(true)
    await fetchData()
    setRefreshing(false)
  }

  const handleStatusChange = async (id, newStatus) => {
    try {
      await updateFeedbackStatus(id, newStatus)
      setItems(prev => prev.map(item =>
        item.id === id ? { ...item, status: newStatus } : item
      ))
    } catch (err) {
      setError(err.message)
    }
  }

  const handleDelete = async (id) => {
    try {
      await deleteFeedback(id)
      setItems(prev => prev.filter(item => item.id !== id))
      setTotal(prev => prev - 1)
    } catch (err) {
      setError(err.message)
    }
  }

  const formatDate = (ts) => {
    if (!ts) return '—'
    const d = new Date(ts)
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) +
      ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="admin-feedback">
      <div className="page-header">
        <div>
          <h1>User Feedback</h1>
          <p className="page-description">{total} total submissions</p>
        </div>
        <button className="icon-btn" onClick={handleRefresh} disabled={refreshing} title="Refresh feedback">
          <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="filters-bar">
        <div className="filter-group">
          <label>Status</label>
          <select value={filters.status} onChange={e => { setFilters({ ...filters, status: e.target.value }); setPage(1) }}>
            {STATUSES.map(s => <option key={s} value={s}>{s === 'all' ? 'All Statuses' : s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
          </select>
        </div>
        <div className="filter-group">
          <label>Type</label>
          <select value={filters.type} onChange={e => { setFilters({ ...filters, type: e.target.value }); setPage(1) }}>
            {TYPES.map(t => <option key={t} value={t}>{t === 'all' ? 'All Types' : TYPE_LABELS[t] || t}</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="admin-loading">Loading feedback...</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <MessageSquare size={32} style={{ stroke: 'rgba(255, 255, 255, 0.5)' }} />
          </div>
          <h3>No feedback yet</h3>
          <p>Submissions will appear here when users send feedback</p>
        </div>
      ) : (
        <div className="feedback-list">
          {items.map(item => (
            <div
              key={item.id}
              className={`feedback-card ${item.status === 'unread' ? 'feedback-card-unread' : ''}`}
              onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
            >
              <div className="feedback-card-header">
                <div className="feedback-card-badges">
                  <span className={`feedback-type-badge type-${item.type}`}>{TYPE_LABELS[item.type] || item.type}</span>
                  <span className={`feedback-status-badge status-${item.status}`}>{item.status}</span>
                </div>
                <span className="feedback-card-date">{formatDate(item.created_at)}</span>
              </div>

              {item.name && <div className="feedback-card-sender">{item.name}{item.email && ` (${item.email})`}</div>}

              <div className="feedback-card-message">{item.message}</div>

              {expandedId === item.id && (
                <div className="feedback-card-actions">
                  {item.status === 'unread' && (
                    <button className="admin-action-btn" onClick={(e) => { e.stopPropagation(); handleStatusChange(item.id, 'read') }}>
                      Mark Read
                    </button>
                  )}
                  {item.status === 'read' && (
                    <button className="admin-action-btn" onClick={(e) => { e.stopPropagation(); handleStatusChange(item.id, 'unread') }}>
                      Mark Unread
                    </button>
                  )}
                  {item.status !== 'archived' && (
                    <button className="admin-action-btn" onClick={(e) => { e.stopPropagation(); handleStatusChange(item.id, 'archived') }}>
                      Archive
                    </button>
                  )}
                  <button className="admin-action-btn admin-action-danger" onClick={(e) => { e.stopPropagation(); handleDelete(item.id) }}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="pagination">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
          <span>Page {page} of {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}
    </div>
  )
}
