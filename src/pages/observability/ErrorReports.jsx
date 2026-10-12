/**
 * Admin Error Reports Page
 * View, filter, and manage auto-captured and user-submitted error reports
 */

import { useState, useEffect, useCallback } from 'react'
import { getErrorReports, updateErrorReportStatus, deleteErrorReport } from '../../services/feedbackClient'
import { RefreshCw, AlertCircle } from 'lucide-react'

const STATUSES = ['all', 'unread', 'read', 'resolved', 'archived']
const ERROR_TYPES = ['all', 'unhandled_error', 'unhandled_rejection', 'react_error_boundary', 'api_error', 'manual']
const TYPE_LABELS = {
  unhandled_error: 'JS Error',
  unhandled_rejection: 'Promise',
  react_error_boundary: 'React Crash',
  api_error: 'API Error',
  manual: 'Manual Report'
}

export default function AdminErrorReports() {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filters, setFilters] = useState({ status: 'all', error_type: 'all' })
  const [expandedId, setExpandedId] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getErrorReports({ ...filters, page })
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
      await updateErrorReportStatus(id, newStatus)
      setItems(prev => prev.map(item =>
        item.id === id ? { ...item, status: newStatus } : item
      ))
    } catch (err) {
      setError(err.message)
    }
  }

  const handleDelete = async (id) => {
    try {
      await deleteErrorReport(id)
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
    <div className="admin-error-reports">
      <div className="page-header">
        <div>
          <h1>Error Reports</h1>
          <p className="page-description">{total} total reports</p>
        </div>
        <button className="icon-btn" onClick={handleRefresh} disabled={refreshing} title="Refresh error reports">
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
          <label>Error Type</label>
          <select value={filters.error_type} onChange={e => { setFilters({ ...filters, error_type: e.target.value }); setPage(1) }}>
            {ERROR_TYPES.map(t => <option key={t} value={t}>{t === 'all' ? 'All Types' : TYPE_LABELS[t] || t}</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="admin-loading">Loading error reports...</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <AlertCircle size={32} style={{ stroke: 'rgba(255, 255, 255, 0.5)' }} />
          </div>
          <h3>No error reports</h3>
          <p>Error reports from users will appear here</p>
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
                  <span className={`feedback-type-badge type-error-${item.error_type}`}>
                    {TYPE_LABELS[item.error_type] || item.error_type}
                  </span>
                  <span className={`feedback-status-badge status-${item.status}`}>{item.status}</span>
                </div>
                <span className="feedback-card-date">{formatDate(item.created_at)}</span>
              </div>

              <div className="feedback-card-message error-message-mono">{item.message}</div>

              {item.user_description && (
                <div className="error-user-description">
                  <span className="error-label">User note:</span> {item.user_description}
                </div>
              )}

              {expandedId === item.id && (
                <div className="feedback-card-expanded">
                  {item.url && (
                    <div className="error-detail-row">
                      <span className="error-label">URL:</span>
                      <span className="error-value">{item.url}</span>
                    </div>
                  )}
                  {item.context && (
                    <div className="error-detail-row">
                      <span className="error-label">Context:</span>
                      <span className="error-value">{item.context}</span>
                    </div>
                  )}
                  {item.stack && (
                    <details className="error-stack-details">
                      <summary>Stack Trace</summary>
                      <pre className="error-stack-trace">{item.stack}</pre>
                    </details>
                  )}
                  {item.component_stack && (
                    <details className="error-stack-details">
                      <summary>Component Stack</summary>
                      <pre className="error-stack-trace">{item.component_stack}</pre>
                    </details>
                  )}

                  <div className="feedback-card-actions">
                    {item.status === 'unread' && (
                      <button className="admin-action-btn" onClick={(e) => { e.stopPropagation(); handleStatusChange(item.id, 'read') }}>
                        Mark Read
                      </button>
                    )}
                    {(item.status === 'unread' || item.status === 'read') && (
                      <button className="admin-action-btn" onClick={(e) => { e.stopPropagation(); handleStatusChange(item.id, 'resolved') }}>
                        Resolve
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
