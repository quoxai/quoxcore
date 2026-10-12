/**
 * DeliveryLogPanel — Delivery log with filtering, status tracking, and retry.
 * Table: timestamp, channel, recipient (masked), title, status, attempts, retry button.
 */

import { useState, useCallback } from 'react'
import { useDeliveryLog } from '../../hooks/useDeliveryLog'
import './comms-layout.css'

const CHANNEL_NAMES = {
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  email: 'Email',
  webhook: 'Webhook',
  in_app: 'In-App',
  sms: 'SMS',
}

const STATUS_CLASSES = {
  sent: 'comms-badge--success',
  delivered: 'comms-badge--success',
  pending: 'comms-badge--warning',
  failed: 'comms-badge--error',
  bounced: 'comms-badge--error',
}

function maskRecipient(recipient) {
  if (!recipient) return '—'
  if (recipient.includes('@')) {
    const [user, domain] = recipient.split('@')
    return `${user.slice(0, 2)}***@${domain}`
  }
  if (recipient.length > 8) {
    return `${recipient.slice(0, 4)}...${recipient.slice(-3)}`
  }
  return recipient
}

function formatTimestamp(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return d.toLocaleString()
}

export default function DeliveryLogPanel() {
  const [statusFilter, setStatusFilter] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [retrying, setRetrying] = useState(null)

  const { deliveries, loading, error, page, totalPages, total, goToPage, retry, refresh } = useDeliveryLog({
    status: statusFilter || undefined,
    channel_type: channelFilter || undefined,
  })

  const handleRetry = useCallback(async (id) => {
    setRetrying(id)
    await retry(id)
    setRetrying(null)
  }, [retry])

  return (
    <div>
      <div className="comms-content__header">
        <h2 className="comms-content__title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          Delivery Log
          {total > 0 && <span style={{ fontSize: 13, fontWeight: 400, opacity: 0.5, marginLeft: 8 }}>({total})</span>}
        </h2>
        <button className="comms-btn comms-btn--ghost" onClick={refresh}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
          </svg>
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="comms-delivery-log__filters">
        <select
          className="comms-delivery-log__filter"
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
        >
          <option value="">All Statuses</option>
          <option value="sent">Sent</option>
          <option value="delivered">Delivered</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
          <option value="bounced">Bounced</option>
        </select>
        <select
          className="comms-delivery-log__filter"
          value={channelFilter}
          onChange={e => setChannelFilter(e.target.value)}
        >
          <option value="">All Channels</option>
          <option value="telegram">Telegram</option>
          <option value="slack">Slack</option>
          <option value="discord">Discord</option>
          <option value="email">Email</option>
          <option value="webhook">Webhook</option>
          <option value="in_app">In-App</option>
        </select>
      </div>

      {error && (
        <div className="comms-badge comms-badge--error" style={{ marginBottom: 12, padding: '8px 12px' }}>{error}</div>
      )}

      {loading ? (
        <div className="comms-loading">
          <svg className="corecomms-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20"/>
          </svg>
          Loading deliveries...
        </div>
      ) : deliveries.length === 0 ? (
        <div className="comms-empty">
          <div className="comms-empty__icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            </svg>
          </div>
          <p>No deliveries found{statusFilter || channelFilter ? ' matching filters' : ''}.</p>
        </div>
      ) : (
        <>
          <table className="comms-delivery-log__table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Channel</th>
                <th>Recipient</th>
                <th>Title</th>
                <th>Status</th>
                <th>Attempts</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map(d => {
                const contentJson = typeof d.content_json === 'string'
                  ? (() => { try { return JSON.parse(d.content_json) } catch { return {} } })()
                  : (d.content_json || {})

                return (
                  <tr key={d.id}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--ui-text-muted, #666)' }}>
                      {formatTimestamp(d.created_at)}
                    </td>
                    <td>{CHANNEL_NAMES[d.channel_type] || d.channel_type}</td>
                    <td style={{ fontSize: 12, fontFamily: 'monospace' }}>
                      {maskRecipient(d.recipient)}
                    </td>
                    <td>
                      <button
                        className="comms-btn comms-btn--ghost comms-btn--sm"
                        onClick={() => setExpandedId(expandedId === d.id ? null : d.id)}
                        style={{ padding: '2px 4px', textDecoration: 'none' }}
                      >
                        {contentJson.title || d.inbox_item_title || 'Notification'}
                      </button>
                    </td>
                    <td>
                      <span className={`comms-badge ${STATUS_CLASSES[d.status] || 'comms-badge--neutral'}`}>
                        {d.status}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                      {d.attempts || 0}
                    </td>
                    <td>
                      {d.status === 'failed' && (
                        <button
                          className="comms-btn comms-btn--sm"
                          onClick={() => handleRetry(d.id)}
                          disabled={retrying === d.id}
                        >
                          {retrying === d.id ? '...' : 'Retry'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* Expanded row detail */}
          {expandedId && deliveries.find(d => d.id === expandedId) && (() => {
            const d = deliveries.find(d => d.id === expandedId)
            return (
              <div className="comms-delivery-log__expand">
                <strong>Delivery ID:</strong> {d.id}<br/>
                {d.last_error && <><strong>Error:</strong> {d.last_error}<br/></>}
                {d.sent_at && <><strong>Sent at:</strong> {new Date(d.sent_at).toLocaleString()}<br/></>}
              </div>
            )
          })()}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="comms-delivery-log__pagination">
              <span>Page {page} of {totalPages}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  className="comms-btn comms-btn--sm"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  Prev
                </button>
                <button
                  className="comms-btn comms-btn--sm"
                  disabled={page >= totalPages}
                  onClick={() => goToPage(page + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
