/**
 * AuditTab - Filterable audit log viewer
 */

import { useState, useEffect, useCallback } from 'react'
import * as bastionClient from '../../services/bastionClient'
import { formatExitCode } from '../../utils/exitCodes'

const ClipboardIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
    <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
  </svg>
)

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="23 4 23 10 17 10"/>
    <polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>
)

const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8"/>
    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
)

const ChevronLeftIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="15 18 9 12 15 6"/>
  </svg>
)

const ChevronRightIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
)

const EVENT_TYPE_COLORS = {
  exec: '#3b82f6',
  auth: '#22c55e',
  host_add: '#8b5cf6',
  host_remove: '#ef4444',
  host_update: '#f59e0b',
  key_generate: '#06b6d4',
  key_deploy: '#10b981',
  key_revoke: '#f43f5e',
  tool_run: '#a855f7',
  sudo_setup: '#f97316',
  ping: '#6b7280',
  config: '#64748b'
}

const EVENT_TYPE_LABELS = {
  exec: 'Command Exec',
  auth: 'Authentication',
  host_add: 'Host Added',
  host_remove: 'Host Removed',
  host_update: 'Host Updated',
  key_generate: 'Key Generated',
  key_deploy: 'Key Deployed',
  key_revoke: 'Key Revoked',
  tool_run: 'Tool Run',
  sudo_setup: 'Sudo Setup',
  ping: 'Ping',
  config: 'Config Change'
}

const PAGE_SIZE = 25

export default function AuditTab({ showNotification, initialFilter, onFilterConsumed }) {
  const [events, setEvents] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [filters, setFilters] = useState({
    type: '',
    search: '',
    since: '',
    until: ''
  })
  const [offset, setOffset] = useState(0)

  // Apply jump filter from command execution
  useEffect(() => {
    if (initialFilter) {
      setFilters(f => ({
        ...f,
        search: initialFilter.search || '',
        since: initialFilter.since ? initialFilter.since.slice(0, 16) : '',
      }))
      setOffset(0)
      setSelectedEvent(null)
      if (onFilterConsumed) onFilterConsumed()
    }
  }, [initialFilter, onFilterConsumed])

  const loadAudit = useCallback(async () => {
    try {
      setLoading(true)
      const params = { limit: PAGE_SIZE, offset }
      if (filters.type) params.type = filters.type
      if (filters.search) params.search = filters.search
      if (filters.since) params.since = filters.since
      if (filters.until) params.until = filters.until

      const data = await bastionClient.queryAuditLog(params)
      setEvents(data.events || data || [])
      setTotal(data.total || (data.events || data || []).length)
    } catch (err) {
      console.error('[AuditTab] Failed to load audit log:', err)
    } finally {
      setLoading(false)
    }
  }, [offset, filters])

  useEffect(() => {
    loadAudit()
  }, [loadAudit])

  const handleFilterChange = useCallback((key, value) => {
    setFilters(f => ({ ...f, [key]: value }))
    setOffset(0)
    setSelectedEvent(null)
  }, [])

  const handleRefresh = useCallback(() => {
    loadAudit()
  }, [loadAudit])

  const formatTime = (ts) => {
    if (!ts) return '-'
    try {
      const d = new Date(ts)
      return d.toLocaleString()
    } catch {
      return ts
    }
  }

  const formatTimeShort = (ts) => {
    if (!ts) return '-'
    try {
      const d = new Date(ts)
      const now = new Date()
      const diff = now - d
      if (diff < 60000) return 'just now'
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
      return d.toLocaleDateString()
    } catch {
      return ts
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <div className="bastion-audit-tab">
      {/* Filters bar */}
      <div className="bastion-audit-filters">
        <div className="bastion-audit-search">
          <SearchIcon />
          <input
            type="text"
            placeholder="Search audit events..."
            value={filters.search}
            onChange={e => handleFilterChange('search', e.target.value)}
          />
        </div>
        <select
          value={filters.type}
          onChange={e => handleFilterChange('type', e.target.value)}
          className="bastion-audit-filter-select"
        >
          <option value="">All Types</option>
          {Object.entries(EVENT_TYPE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <input
          type="date"
          value={filters.since}
          onChange={e => handleFilterChange('since', e.target.value)}
          className="bastion-audit-date"
          title="Since date"
        />
        <input
          type="date"
          value={filters.until}
          onChange={e => handleFilterChange('until', e.target.value)}
          className="bastion-audit-date"
          title="Until date"
        />
        <button className="bastion-audit-refresh-btn" onClick={handleRefresh} title="Refresh">
          <RefreshIcon />
        </button>
      </div>

      <div className="bastion-audit-layout">
        {/* Left: Event list */}
        <div className="bastion-audit-list">
          <div className="bastion-audit-list-header">
            <ClipboardIcon />
            <span>Audit Log</span>
            <span className="bastion-audit-count">{total}</span>
          </div>

          {loading ? (
            <div className="bastion-audit-loading">Loading events...</div>
          ) : events.length === 0 ? (
            <div className="bastion-audit-empty">No audit events found</div>
          ) : (
            <>
              {events.map((evt, i) => {
                const evtType = evt.event_type || evt.type || 'unknown'
                const color = EVENT_TYPE_COLORS[evtType] || '#6b7280'
                return (
                  <div
                    key={evt.id || i}
                    role="button"
                    tabIndex={0}
                    className={`bastion-audit-item ${selectedEvent === evt ? 'bastion-audit-item-active' : ''}`}
                    onClick={() => setSelectedEvent(evt)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedEvent(evt) } }}
                  >
                    <div className="bastion-audit-item-top">
                      <span
                        className="bastion-audit-type-badge"
                        style={{ color, borderColor: color }}
                      >
                        {EVENT_TYPE_LABELS[evtType] || evtType}
                      </span>
                      <span className="bastion-audit-time">{formatTimeShort(evt.timestamp || evt.ts)}</span>
                    </div>
                    <div className="bastion-audit-item-summary">
                      {evt.summary || evt.command || evt.host_id || evt.description || evtType}
                    </div>
                    {evt.client_ip && (
                      <div className="bastion-audit-item-source">{evt.client_ip}</div>
                    )}
                  </div>
                )
              })}

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="bastion-audit-pagination">
                  <button
                    onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))}
                    disabled={offset === 0}
                    className="bastion-audit-page-btn"
                  >
                    <ChevronLeftIcon />
                  </button>
                  <span className="bastion-audit-page-info">
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    onClick={() => setOffset(o => o + PAGE_SIZE)}
                    disabled={currentPage >= totalPages}
                    className="bastion-audit-page-btn"
                  >
                    <ChevronRightIcon />
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right: Event detail */}
        <div className="bastion-audit-detail">
          {selectedEvent ? (
            <>
              <div className="bastion-audit-detail-header">
                <h3>{EVENT_TYPE_LABELS[selectedEvent.event_type || selectedEvent.type] || 'Event'}</h3>
                <span className="bastion-audit-detail-time">
                  {formatTime(selectedEvent.timestamp || selectedEvent.ts)}
                </span>
              </div>

              <div className="bastion-audit-detail-meta">
                {selectedEvent.id && (
                  <div className="bastion-audit-meta-row">
                    <span className="bastion-audit-meta-label">ID:</span>
                    <span className="bastion-audit-meta-value">{selectedEvent.id}</span>
                  </div>
                )}
                {(selectedEvent.event_type || selectedEvent.type) && (
                  <div className="bastion-audit-meta-row">
                    <span className="bastion-audit-meta-label">Type:</span>
                    <span className="bastion-audit-meta-value" style={{ color: EVENT_TYPE_COLORS[selectedEvent.event_type || selectedEvent.type] || '#6b7280' }}>
                      {selectedEvent.event_type || selectedEvent.type}
                    </span>
                  </div>
                )}
                {selectedEvent.host_id && (
                  <div className="bastion-audit-meta-row">
                    <span className="bastion-audit-meta-label">Host:</span>
                    <span className="bastion-audit-meta-value">{selectedEvent.host_id}</span>
                  </div>
                )}
                {selectedEvent.user && (
                  <div className="bastion-audit-meta-row">
                    <span className="bastion-audit-meta-label">User:</span>
                    <span className="bastion-audit-meta-value">{selectedEvent.user}</span>
                  </div>
                )}
                {selectedEvent.client_ip && (
                  <div className="bastion-audit-meta-row">
                    <span className="bastion-audit-meta-label">Source IP:</span>
                    <span className="bastion-audit-meta-value">{selectedEvent.client_ip}</span>
                  </div>
                )}
                {selectedEvent.command && (
                  <div className="bastion-audit-meta-row">
                    <span className="bastion-audit-meta-label">Command:</span>
                    <span className="bastion-audit-meta-value bastion-audit-command">{selectedEvent.command}</span>
                  </div>
                )}
                {selectedEvent.exit_code !== undefined && (
                  <div className="bastion-audit-meta-row">
                    <span className="bastion-audit-meta-label">Exit code:</span>
                    <span className="bastion-audit-meta-value" style={{ color: selectedEvent.exit_code === 0 ? '#22c55e' : '#ef4444' }}>
                      {formatExitCode(selectedEvent.exit_code)}
                    </span>
                  </div>
                )}
                {selectedEvent.duration_ms !== undefined && (
                  <div className="bastion-audit-meta-row">
                    <span className="bastion-audit-meta-label">Duration:</span>
                    <span className="bastion-audit-meta-value">{selectedEvent.duration_ms}ms</span>
                  </div>
                )}
              </div>

              {/* Raw event data */}
              <div className="bastion-audit-raw">
                <h4>Raw Event</h4>
                <pre>{JSON.stringify(selectedEvent, null, 2)}</pre>
              </div>
            </>
          ) : (
            <div className="bastion-audit-placeholder">
              <ClipboardIcon />
              <p>Select an event to view details</p>
            </div>
          )}
        </div>
      </div>

      <style>{`
        .bastion-audit-tab {
          padding: 0;
        }
        .bastion-audit-filters {
          display: flex;
          gap: 8px;
          align-items: center;
          padding: 12px 16px;
          border-bottom: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
        }
        .bastion-audit-search {
          flex: 1;
          position: relative;
          display: flex;
          align-items: center;
        }
        .bastion-audit-search svg {
          position: absolute;
          left: 10px;
          color: rgba(255,255,255,0.7);
          pointer-events: none;
        }
        .bastion-audit-search input {
          width: 100%;
          padding: 7px 10px 7px 32px;
          background: rgba(255,255,255,0.06);
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
          border-radius: 10px;
          color: #fff;
          font-size: 13px;
        }
        .bastion-audit-search input::placeholder {
          color: rgba(255,255,255,0.5);
        }
        .bastion-audit-search input:focus {
          outline: none;
          border-color: rgba(56,189,248,0.5);
          box-shadow: 0 0 0 3px rgba(56,189,248,0.12);
        }
        .bastion-audit-filter-select,
        .bastion-audit-date {
          padding: 7px 10px;
          background: rgba(255,255,255,0.05);
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.1));
          border-radius: 4px;
          color: var(--m-text-primary, #f4f4f5);
          font-size: 13px;
        }
        .bastion-audit-date {
          max-width: 140px;
        }
        .bastion-audit-refresh-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          background: rgba(255,255,255,0.04);
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.1));
          border-radius: 4px;
          color: rgba(255,255,255,0.8);
          cursor: pointer;
        }
        .bastion-audit-refresh-btn:hover {
          background: rgba(255,255,255,0.08);
          color: var(--m-text-primary, #f4f4f5);
        }
        .bastion-audit-layout {
          display: grid;
          grid-template-columns: 340px 1fr;
          gap: 0;
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }
        .bastion-audit-list {
          border-right: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
          overflow-y: auto;
          min-width: 0;
          min-height: 0;
          display: block;
          padding: 10px 10px 16px;
        }
        .bastion-audit-list-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px;
          font-weight: 600;
          font-size: 13px;
          color: var(--m-text-primary, #f4f4f5);
          border-bottom: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
        }
        .bastion-audit-count {
          margin-left: auto;
          font-size: 11px;
          padding: 1px 6px;
          background: rgba(255,255,255,0.06);
          border-radius: 10px;
          color: rgba(255,255,255,0.8);
        }
        .bastion-audit-loading,
        .bastion-audit-empty {
          color: rgba(255,255,255,0.7);
          padding: 40px 16px;
          text-align: center;
          font-size: 13px;
        }
        .bastion-audit-item {
          display: flex;
          flex-direction: column;
          gap: 8px;
          width: 100%;
          min-width: 0;
          height: auto !important;
          min-height: 0;
          box-sizing: border-box;
          padding: 14px 16px;
          margin-bottom: 10px;
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 10px;
          color: rgba(255,255,255,0.85);
          cursor: pointer;
          text-align: left;
          font: inherit;
          line-height: 1.4;
          overflow: visible;
          flex-shrink: 0;
        }
        .bastion-audit-item-top {
          display: flex;
          flex-direction: row;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          width: 100%;
          min-width: 0;
        }
        .bastion-audit-item-summary {
          width: 100%;
          min-width: 0;
          max-width: 100%;
          box-sizing: border-box;
        }
        .bastion-audit-item-source {
          width: 100%;
          box-sizing: border-box;
          padding-top: 4px;
          border-top: 1px dashed rgba(255,255,255,0.08);
        }
        .bastion-audit-item:hover {
          background: rgba(255,255,255,0.02);
        }
        .bastion-audit-item-active {
          background: rgba(59, 130, 246, 0.08);
          border-left-color: #3b82f6;
        }
        .bastion-audit-item-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .bastion-audit-type-badge {
          font-size: 10px;
          font-weight: 600;
          padding: 1px 6px;
          border: 1px solid;
          border-radius: 3px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }
        .bastion-audit-time {
          font-size: 11px;
          color: rgba(255,255,255,0.7);
        }
        .bastion-audit-item-summary {
          font-size: 13px;
          color: var(--m-text-primary, #f4f4f5);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .bastion-audit-item-source {
          font-size: 11px;
          color: rgba(255,255,255,0.7);
        }
        .bastion-audit-pagination {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 10px;
          border-top: 1px solid var(--m-border-default, rgba(255,255,255,0.06));
        }
        .bastion-audit-page-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          background: rgba(255,255,255,0.04);
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.1));
          border-radius: 4px;
          color: rgba(255,255,255,0.8);
          cursor: pointer;
        }
        .bastion-audit-page-btn:hover:not(:disabled) {
          background: rgba(255,255,255,0.08);
        }
        .bastion-audit-page-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        .bastion-audit-page-info {
          font-size: 12px;
          color: rgba(255,255,255,0.7);
        }
        .bastion-audit-detail {
          padding: 20px 24px;
          overflow-y: auto;
          max-height: calc(100vh - 320px);
        }
        .bastion-audit-detail-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 16px;
        }
        .bastion-audit-detail-header h3 {
          margin: 0;
          font-size: 18px;
          color: var(--m-text-primary, #f4f4f5);
        }
        .bastion-audit-detail-time {
          font-size: 12px;
          color: rgba(255,255,255,0.7);
        }
        .bastion-audit-detail-meta {
          margin-bottom: 16px;
          padding: 12px;
          background: rgba(255,255,255,0.02);
          border-radius: 6px;
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.06));
        }
        .bastion-audit-meta-row {
          display: flex;
          gap: 8px;
          padding: 4px 0;
          font-size: 13px;
        }
        .bastion-audit-meta-label {
          color: rgba(255,255,255,0.7);
          min-width: 90px;
          flex-shrink: 0;
        }
        .bastion-audit-meta-value {
          color: var(--m-text-primary, #f4f4f5);
          word-break: break-all;
        }
        .bastion-audit-command {
          font-family: monospace;
          padding: 2px 6px;
          background: rgba(0,0,0,0.3);
          border-radius: 3px;
          font-size: 12px;
        }
        .bastion-audit-raw {
          margin-top: 16px;
        }
        .bastion-audit-raw h4 {
          font-size: 13px;
          color: var(--m-text-primary, #f4f4f5);
          margin: 0 0 8px;
          font-weight: 600;
        }
        .bastion-audit-raw pre {
          margin: 0;
          padding: 12px;
          background: rgba(255,255,255,0.05);
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
          border-radius: 6px;
          font-size: 12px;
          color: rgba(255,255,255,0.8);
          overflow-x: auto;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 400px;
          overflow-y: auto;
        }
        .bastion-audit-placeholder {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          color: rgba(255,255,255,0.7);
          padding: 60px 20px;
          text-align: center;
        }
        .bastion-audit-placeholder p {
          margin: 0;
          font-size: 13px;
        }

        /* ═══ Glass polish (Janus V2 — tab parity) ═══ */
        .bastion-audit-tab {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }
        .bastion-audit-filters {
          flex-shrink: 0;
          padding: 14px 18px;
          background: linear-gradient(rgba(0,0,0,0.28), rgba(0,0,0,0.28)),
            rgba(255,255,255,0.05);
          backdrop-filter: blur(20px) saturate(1.4);
          -webkit-backdrop-filter: blur(20px) saturate(1.4);
          border-bottom: 1px solid rgba(255,255,255,0.18);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.12);
        }
        .bastion-audit-search input,
        .bastion-audit-filter-select,
        .bastion-audit-date {
          background: rgba(255,255,255,0.06) !important;
          border: 1px solid rgba(255,255,255,0.14) !important;
          color: #fff !important;
          transition: border-color 0.15s ease, background 0.15s ease;
        }
        .bastion-audit-search input:focus,
        .bastion-audit-filter-select:focus,
        .bastion-audit-date:focus {
          border-color: rgba(56,189,248,0.5) !important;
          background: rgba(255,255,255,0.08) !important;
          box-shadow: 0 0 0 3px rgba(56,189,248,0.12);
        }
        .bastion-audit-refresh-btn {
          background: rgba(255,255,255,0.06) !important;
          border: 1px solid rgba(255,255,255,0.14) !important;
          color: #fff !important;
          transition: all 0.15s ease;
        }
        .bastion-audit-refresh-btn:hover {
          background: rgba(255,255,255,0.1) !important;
          border-color: rgba(56,189,248,0.4) !important;
          transform: translateY(-1px);
        }
        .bastion-audit-list {
          border-right: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.015);
        }
        .bastion-audit-list-header {
          /* Plain header — NO sticky, NO own backdrop-filter, NO dark overlay.
             The morphism comes from the parent panel frame, same as every
             other panel in the app. */
          background: transparent !important;
          border-bottom: 1px solid rgba(255,255,255,0.18) !important;
          box-shadow: none !important;
          padding: 14px 16px !important;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          font-size: 11px !important;
          color: #fff !important;
          font-weight: 700 !important;
        }
        .bastion-audit-count {
          background: rgba(56,189,248,0.14) !important;
          color: #38bdf8 !important;
          border: 1px solid rgba(56,189,248,0.25);
        }
        .bastion-audit-item:hover {
          background: rgba(255,255,255,0.06) !important;
          border-color: rgba(255,255,255,0.16) !important;
        }
        .bastion-audit-item-active {
          background: linear-gradient(90deg, rgba(168,85,247,0.18), rgba(56,189,248,0.06)) !important;
          border: 1px solid rgba(168,85,247,0.5) !important;
          border-left: 3px solid #a855f7 !important;
          box-shadow: 0 4px 18px rgba(168,85,247,0.18), inset 0 1px 0 rgba(255,255,255,0.1) !important;
        }
        .bastion-audit-detail {
          background: rgba(255,255,255,0.01);
        }
        .bastion-audit-detail-meta {
          backdrop-filter: blur(16px) saturate(1.3);
          -webkit-backdrop-filter: blur(16px) saturate(1.3);
          background: rgba(255,255,255,0.04) !important;
          border: 1px solid rgba(255,255,255,0.14) !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.1);
          padding: 14px 16px !important;
          border-radius: 10px !important;
        }
        .bastion-audit-command {
          background: rgba(0,0,0,0.4) !important;
          border: 1px solid rgba(255,255,255,0.1);
          color: #38bdf8 !important;
        }
        .bastion-audit-raw pre {
          backdrop-filter: blur(16px) saturate(1.3);
          -webkit-backdrop-filter: blur(16px) saturate(1.3);
          background: rgba(0,0,0,0.35) !important;
          border: 1px solid rgba(255,255,255,0.14) !important;
          border-radius: 10px !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
        }
        .bastion-audit-page-btn {
          background: rgba(255,255,255,0.06) !important;
          border: 1px solid rgba(255,255,255,0.14) !important;
          color: #fff !important;
          transition: all 0.15s ease;
        }
        .bastion-audit-page-btn:hover:not(:disabled) {
          background: rgba(56,189,248,0.14) !important;
          border-color: rgba(56,189,248,0.4) !important;
        }
      `}</style>
    </div>
  )
}
