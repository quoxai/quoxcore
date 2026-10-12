/**
 * RouterAuditLog - Routing Decision History View
 *
 * Shows a filterable, paginated history of routing decisions.
 * Includes query, pattern matched, confidence, outcome, and user feedback.
 *
 * Part of the Smart Router visibility enhancement initiative.
 *
 * Security Issue #69: Moved from localStorage to server-side storage
 * All router audit events are now stored in the backend database.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { getRouterStats } from '../../services/quoxRouter'
import { getFeedbackStats } from './RouterFeedback'
import { csrfFetch } from '../../utils/csrfFetch'
import { buildAuthApiUrl } from '../../services/authApiUrl'
import './router.css'

const DEV_ORG_ID = '01DEV000000000000000000002'

/**
 * Get the API URL
 */
function getApiUrl(path) {
  return buildAuthApiUrl(path)
}

/**
 * Get current organization ID from context
 */
function getOrgId() {
  if (typeof localStorage === 'undefined') return DEV_ORG_ID

  const orgContext = localStorage.getItem('quox-org-context')
  if (orgContext) {
    try {
      const parsed = JSON.parse(orgContext)
      if (parsed.orgId) return parsed.orgId
      if (parsed.id) return parsed.id
    } catch {
      // Fall through
    }
  }

  const authContext = localStorage.getItem('quox-auth-context')
  if (authContext) {
    try {
      const parsed = JSON.parse(authContext)
      if (parsed.org?.id) return parsed.org.id
    } catch {
      // Fall through
    }
  }

  return DEV_ORG_ID
}

/**
 * Store router decision audit entry to server
 */
export async function logRouterDecision(entry) {
  const orgId = getOrgId()
  const url = getApiUrl(`/orgs/${orgId}/audit`)

  const eventData = {
    action: entry.handled ? 'frontend.router.decision' : 'frontend.router.escalation',
    operation: entry.pattern ? `Router: ${entry.pattern}` : 'Router: Passed to Claude',
    query: entry.query || '',
    status: entry.handled ? 'success' : 'denied',
    metadata: {
      pattern: entry.pattern || null,
      confidence: entry.confidence || null,
      handled: entry.handled || false,
      reason: entry.reason || null,
      feedback: entry.feedback,
      source: 'router'
    }
  }

  try {
    const response = await csrfFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(eventData)
    })

    if (!response.ok) {
      console.warn('[RouterAuditLog] Failed to log decision:', response.statusText)
    }
  } catch (err) {
    console.warn('[RouterAuditLog] Failed to store entry:', err.message)
  }
}

/**
 * Get router audit log entries from server
 */
async function getAuditLog() {
  const orgId = getOrgId()
  const params = new URLSearchParams({
    limit: '500',
    action: 'frontend.router.decision'
  })
  const url = getApiUrl(`/orgs/${orgId}/audit?${params}`)

  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      throw new Error('Failed to fetch router audit log')
    }

    const result = await response.json()

    // Transform to expected format
    return (result.events || []).map(event => {
      const metadata = event.metadata || {}
      return {
        id: event.id,
        ts: new Date(event.created_at).getTime(),
        query: metadata.query || '',
        pattern: metadata.pattern || null,
        confidence: metadata.confidence || null,
        handled: metadata.handled || false,
        reason: metadata.reason || null,
        feedback: metadata.feedback
      }
    })
  } catch (err) {
    console.error('[RouterAuditLog] Failed to fetch audit log:', err.message)
    return []
  }
}

/**
 * Clear audit log
 * Note: Server-side audit logs cannot be cleared for security/compliance.
 */
export function clearAuditLog() {
  console.warn('[RouterAuditLog] Clearing audit logs is disabled for security. Audit logs are tamper-evident and append-only.')
}

/**
 * Export audit log as CSV
 */
export async function exportAuditLogCSV() {
  const log = await getAuditLog()
  const headers = ['Timestamp', 'Query', 'Pattern', 'Confidence', 'Outcome', 'Feedback']

  const rows = log.map(entry => [
    new Date(entry.ts).toISOString(),
    `"${(entry.query || '').replace(/"/g, '""')}"`,
    entry.pattern || 'none',
    entry.confidence ? Math.round(entry.confidence * 100) + '%' : 'N/A',
    entry.handled ? 'Routed' : entry.reason || 'Passed',
    entry.feedback === true ? 'Positive' : entry.feedback === false ? 'Negative' : ''
  ])

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')

  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `router-audit-log-${new Date().toISOString().split('T')[0]}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * RouterAuditLog Component
 */
export function RouterAuditLog() {
  const [log, setLog] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState({
    pattern: '',
    outcome: 'all', // all, routed, passed, escalated
    confidenceMin: 0,
    confidenceMax: 100,
    dateFrom: '',
    dateTo: ''
  })
  const [page, setPage] = useState(0)
  const pageSize = 20

  // Load log data
  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      try {
        const logData = await getAuditLog()
        const stats = getRouterStats()
        const feedbackStats = getFeedbackStats()

        // Merge stats into log entries for display
        // Note: Real implementation would store this with each entry
        setLog(logData)
      } catch (err) {
        console.error('[RouterAuditLog] Failed to load data:', err)
      } finally {
        setLoading(false)
      }
    }

    loadData()

    // Refresh every 30 seconds
    const interval = setInterval(loadData, 30000)
    return () => clearInterval(interval)
  }, [])

  // Filter log entries
  const filteredLog = useMemo(() => {
    return log.filter(entry => {
      // Pattern filter
      if (filter.pattern && entry.pattern && !entry.pattern.includes(filter.pattern.toLowerCase())) {
        return false
      }

      // Outcome filter
      if (filter.outcome === 'routed' && !entry.handled) return false
      if (filter.outcome === 'passed' && entry.handled) return false
      if (filter.outcome === 'escalated' && entry.reason !== 'user-escalation') return false

      // Confidence filter
      const confidence = (entry.confidence || 0) * 100
      if (confidence < filter.confidenceMin || confidence > filter.confidenceMax) return false

      // Date filter
      if (filter.dateFrom) {
        const from = new Date(filter.dateFrom).getTime()
        if (entry.ts < from) return false
      }
      if (filter.dateTo) {
        const to = new Date(filter.dateTo).getTime() + 86400000 // Include end date
        if (entry.ts > to) return false
      }

      return true
    })
  }, [log, filter])

  // Paginate
  const paginatedLog = useMemo(() => {
    const start = page * pageSize
    return filteredLog.slice(start, start + pageSize)
  }, [filteredLog, page])

  const totalPages = Math.ceil(filteredLog.length / pageSize)

  // Get unique patterns for filter dropdown
  const uniquePatterns = useMemo(() => {
    const patterns = new Set(log.map(e => e.pattern).filter(Boolean))
    return [...patterns].sort()
  }, [log])

  const handleExport = useCallback(() => {
    exportAuditLogCSV()
  }, [])

  const handleClear = useCallback(() => {
    // Clearing is disabled for security
    alert('Clearing audit logs is disabled for security. Audit logs are tamper-evident and stored server-side.')
  }, [])

  const formatTimestamp = (ts) => {
    const date = new Date(ts)
    const now = new Date()
    const diff = now - date

    // Less than 1 hour ago
    if (diff < 3600000) {
      const mins = Math.floor(diff / 60000)
      return mins <= 1 ? 'Just now' : `${mins}m ago`
    }

    // Less than 24 hours ago
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000)
      return `${hours}h ago`
    }

    // Same year
    if (date.getFullYear() === now.getFullYear()) {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }

    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  if (loading) {
    return (
      <div className="router-audit-log router-audit-log--loading">
        Loading audit log...
      </div>
    )
  }

  return (
    <div className="router-audit-log">
      {/* Header */}
      <div className="router-audit-log-header">
        <h3 className="router-audit-log-title">Routing Audit Log</h3>
        <div className="router-audit-log-actions">
          <button className="router-audit-log-btn" onClick={handleExport}>
            Export CSV
          </button>
          <button className="router-audit-log-btn router-audit-log-btn--disabled" onClick={handleClear} title="Audit logs are append-only for security">
            Clear Log
          </button>
        </div>
      </div>

      {/* Security notice */}
      <div className="router-audit-log-notice">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        Audit logs are stored server-side and are tamper-evident (append-only).
      </div>

      {/* Filters */}
      <div className="router-audit-log-filters">
        <div className="router-audit-log-filter">
          <label>Pattern</label>
          <select
            value={filter.pattern}
            onChange={(e) => setFilter(f => ({ ...f, pattern: e.target.value }))}
          >
            <option value="">All patterns</option>
            {uniquePatterns.map(p => (
              <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>

        <div className="router-audit-log-filter">
          <label>Outcome</label>
          <select
            value={filter.outcome}
            onChange={(e) => setFilter(f => ({ ...f, outcome: e.target.value }))}
          >
            <option value="all">All outcomes</option>
            <option value="routed">Routed</option>
            <option value="passed">Passed to Claude</option>
            <option value="escalated">User escalated</option>
          </select>
        </div>

        <div className="router-audit-log-filter">
          <label>Confidence</label>
          <div className="router-audit-log-range">
            <input
              type="number"
              min="0"
              max="100"
              value={filter.confidenceMin}
              onChange={(e) => setFilter(f => ({ ...f, confidenceMin: parseInt(e.target.value) || 0 }))}
              placeholder="Min"
            />
            <span>-</span>
            <input
              type="number"
              min="0"
              max="100"
              value={filter.confidenceMax}
              onChange={(e) => setFilter(f => ({ ...f, confidenceMax: parseInt(e.target.value) || 100 }))}
              placeholder="Max"
            />
            <span>%</span>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="router-audit-log-stats">
        <span>Showing {filteredLog.length} of {log.length} entries</span>
      </div>

      {/* Empty state */}
      {filteredLog.length === 0 && (
        <div className="router-audit-log-empty">
          <p>No routing decisions recorded yet.</p>
          <p className="router-audit-log-empty-hint">
            Decisions will appear here as you use the Smart Router.
          </p>
        </div>
      )}

      {/* Table */}
      {filteredLog.length > 0 && (
        <div className="router-audit-log-table-wrapper">
          <table className="router-audit-log-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Query</th>
                <th>Pattern</th>
                <th>Confidence</th>
                <th>Outcome</th>
                <th>Feedback</th>
              </tr>
            </thead>
            <tbody>
              {paginatedLog.map(entry => (
                <tr key={entry.id} className={`router-audit-log-row router-audit-log-row--${entry.handled ? 'routed' : 'passed'}`}>
                  <td className="router-audit-log-time">
                    {formatTimestamp(entry.ts)}
                  </td>
                  <td className="router-audit-log-query" title={entry.query}>
                    {entry.query?.slice(0, 50)}{entry.query?.length > 50 ? '...' : ''}
                  </td>
                  <td className="router-audit-log-pattern">
                    {entry.pattern ? entry.pattern.replace(/_/g, ' ') : '-'}
                  </td>
                  <td className="router-audit-log-confidence">
                    {entry.confidence ? `${Math.round(entry.confidence * 100)}%` : '-'}
                  </td>
                  <td className="router-audit-log-outcome">
                    <span className={`router-audit-log-badge router-audit-log-badge--${entry.handled ? 'routed' : entry.reason === 'user-escalation' ? 'escalated' : 'passed'}`}>
                      {entry.handled ? 'Routed' : entry.reason === 'user-escalation' ? 'Escalated' : 'Passed'}
                    </span>
                  </td>
                  <td className="router-audit-log-feedback">
                    {entry.feedback === true && <span className="router-audit-log-feedback--positive">{'\u{1F44D}'}</span>}
                    {entry.feedback === false && <span className="router-audit-log-feedback--negative">{'\u{1F44E}'}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="router-audit-log-pagination">
          <button
            className="router-audit-log-page-btn"
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            Previous
          </button>
          <span className="router-audit-log-page-info">
            Page {page + 1} of {totalPages}
          </span>
          <button
            className="router-audit-log-page-btn"
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}

export default RouterAuditLog
