/**
 * Admin System Logs
 * View and filter system logs
 */

import { useState, useEffect } from 'react'
import { RefreshCw, ScrollText } from 'lucide-react'

const AUTH_API = '/api'

const LEVELS = ['all', 'error', 'warn', 'info', 'debug']
const SERVICES = ['all', 'auth', 'api', 'worker', 'collector']

export default function AdminLogs() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filters, setFilters] = useState({
    service: 'all',
    level: 'all',
    limit: 100
  })
  const [expandedLog, setExpandedLog] = useState(null)

  useEffect(() => {
    fetchLogs()
  }, [filters])

  const fetchLogs = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filters.service !== 'all') params.set('service', filters.service)
      if (filters.level !== 'all') params.set('level', filters.level)
      params.set('limit', filters.limit.toString())

      const res = await fetch(`${AUTH_API}/admin/logs?${params}`, {
        credentials: 'include'
      })

      if (!res.ok) throw new Error('Failed to fetch logs')

      const data = await res.json()
      setLogs(data.logs)
      setLoading(false)
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  const getLevelClass = (level) => {
    switch (level) {
      case 'error': return 'level-error'
      case 'warn': return 'level-warn'
      case 'info': return 'level-info'
      case 'debug': return 'level-debug'
      default: return ''
    }
  }

  const formatTime = (timestamp) => {
    const date = new Date(timestamp)
    return date.toLocaleString()
  }

  const toggleExpand = (logId) => {
    setExpandedLog(expandedLog === logId ? null : logId)
  }

  return (
    <div className="admin-logs">
      <div className="page-header">
        <div>
          <h1>System Logs</h1>
          <p className="page-description">View recent system logs and errors</p>
        </div>
        <button className="icon-btn" onClick={fetchLogs} title="Refresh logs">
          <RefreshCw size={16} />
        </button>
      </div>

      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Filters */}
      <div className="filters-bar">
        <div className="filter-group">
          <label>Service</label>
          <select
            value={filters.service}
            onChange={e => setFilters({ ...filters, service: e.target.value })}
          >
            {SERVICES.map(s => (
              <option key={s} value={s}>{s === 'all' ? 'All Services' : s}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label>Level</label>
          <select
            value={filters.level}
            onChange={e => setFilters({ ...filters, level: e.target.value })}
          >
            {LEVELS.map(l => (
              <option key={l} value={l}>{l === 'all' ? 'All Levels' : l.toUpperCase()}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label>Limit</label>
          <select
            value={filters.limit}
            onChange={e => setFilters({ ...filters, limit: parseInt(e.target.value) })}
          >
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="250">250</option>
            <option value="500">500</option>
          </select>
        </div>
      </div>

      {/* Logs Table */}
      {loading ? (
        <div className="admin-loading">Loading logs...</div>
      ) : logs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><ScrollText size={32} style={{ stroke: 'rgba(255, 255, 255, 0.5)' }} /></div>
          <h3>No Logs Found</h3>
          <p>No logs match your current filters</p>
        </div>
      ) : (
        <div className="logs-table">
          <div className="logs-header">
            <div className="col-time">Time</div>
            <div className="col-level">Level</div>
            <div className="col-service">Service</div>
            <div className="col-message">Message</div>
          </div>

          {logs.map(log => (
            <div
              key={log.id}
              className={`log-row ${getLevelClass(log.level)} ${expandedLog === log.id ? 'expanded' : ''}`}
              onClick={() => toggleExpand(log.id)}
            >
              <div className="log-summary">
                <div className="col-time">{formatTime(log.created_at)}</div>
                <div className="col-level">
                  <span className={`level-badge ${getLevelClass(log.level)}`}>
                    {log.level.toUpperCase()}
                  </span>
                </div>
                <div className="col-service">{log.service}</div>
                <div className="col-message">{log.message}</div>
              </div>

              {expandedLog === log.id && (
                <div className="log-details">
                  {log.error_stack && (
                    <div className="detail-section">
                      <div className="detail-label">Stack Trace</div>
                      <pre className="stack-trace">{log.error_stack}</pre>
                    </div>
                  )}

                  {log.request_id && (
                    <div className="detail-row">
                      <span className="detail-label">Request ID</span>
                      <span className="detail-value">{log.request_id}</span>
                    </div>
                  )}

                  {log.user_id && (
                    <div className="detail-row">
                      <span className="detail-label">User ID</span>
                      <span className="detail-value">{log.user_id}</span>
                    </div>
                  )}

                  {log.metadata && Object.keys(log.metadata).length > 0 && (
                    <div className="detail-section">
                      <div className="detail-label">Metadata</div>
                      <pre className="metadata-json">{JSON.stringify(log.metadata, null, 2)}</pre>
                    </div>
                  )}

                  <div className="detail-row">
                    <span className="detail-label">Log ID</span>
                    <span className="detail-value code">{log.id}</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Stats */}
      {logs.length > 0 && (
        <div className="logs-stats">
          Showing {logs.length} logs
          {filters.service !== 'all' && ` from ${filters.service}`}
          {filters.level !== 'all' && ` at ${filters.level} level`}
        </div>
      )}
    </div>
  )
}
