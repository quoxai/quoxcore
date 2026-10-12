/**
 * VoltEventChain — Vertical hash-chain event timeline
 *
 * Renders a linked list of VOLT events showing:
 * - Color-coded event type badges
 * - Actor + timestamp + sequence number
 * - Hash chain links (prev_hash → hash, truncated)
 * - Expandable detail: full hashes, payload JSON, context
 *
 * Shows first 50 events with a "Load more" button for large chains.
 */

import { useState, useMemo } from 'react'

const PAGE_SIZE = 50

/**
 * Event type → color map
 */
const EVENT_COLORS = {
  'run.started':              { bg: 'rgba(52, 211, 153, 0.15)',  fg: '#34d399' },
  'run.completed':            { bg: 'rgba(52, 211, 153, 0.15)',  fg: '#34d399' },
  'aee.envelope.received':    { bg: 'rgba(56, 189, 248, 0.15)',  fg: '#38bdf8' },
  'aee.envelope.sent':        { bg: 'rgba(99, 102, 241, 0.15)',  fg: '#6366f1' },
  'tool.call.requested':      { bg: 'rgba(251, 191, 36, 0.15)',  fg: '#fbbf24' },
  'tool.call.executed':       { bg: 'rgba(251, 191, 36, 0.15)',  fg: '#fbbf24' },
  'model.responded':          { bg: 'rgba(167, 139, 250, 0.15)', fg: '#a78bfa' },
  'aocl.policy.evaluated':    { bg: 'rgba(168, 85, 247, 0.15)',  fg: '#a855f7' },
  'hitl.requested':           { bg: 'rgba(249, 115, 22, 0.15)',  fg: '#f97316' },
  'hitl.approved':            { bg: 'rgba(34, 197, 94, 0.15)',   fg: '#22c55e' },
  'hitl.denied':              { bg: 'rgba(239, 68, 68, 0.15)',   fg: '#ef4444' },
  'credential.accessed':      { bg: 'rgba(239, 68, 68, 0.15)',   fg: '#ef4444' },
}

const DEFAULT_COLOR = { bg: 'rgba(100, 116, 139, 0.15)', fg: '#64748b' }

function getColor(eventType) {
  return EVENT_COLORS[eventType] || DEFAULT_COLOR
}

function truncHash(hash) {
  if (!hash) return '—'
  return hash.slice(0, 8) + '…' + hash.slice(-6)
}

function formatEventTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function VoltEventChain({ events = [], loading = false }) {
  const [expandedId, setExpandedId] = useState(null)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const visible = useMemo(() => events.slice(0, visibleCount), [events, visibleCount])
  const hasMore = events.length > visibleCount

  if (loading) {
    return (
      <div className="volt-state">
        <div className="volt-spinner" />
        <div className="volt-state__text">Loading events…</div>
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="volt-state">
        <div className="volt-state__text">No events recorded for this run.</div>
      </div>
    )
  }

  return (
    <div className="volt-chain" role="list" aria-label="Event chain">
      <div className="volt-chain__line" />

      {visible.map((evt) => {
        const color = getColor(evt.event_type)
        const isExpanded = expandedId === evt.event_id

        return (
          <div key={evt.event_id} className="volt-chain__node" role="listitem">
            <div
              className="volt-chain__dot"
              style={{ background: color.fg }}
            />

            <div
              className={`volt-chain__card${isExpanded ? ' volt-chain__card--expanded' : ''}`}
              onClick={() => setExpandedId(isExpanded ? null : evt.event_id)}
            >
              {/* Header row */}
              <div className="volt-chain__card-header">
                <span className="volt-chain__seq">#{evt.seq}</span>
                <span
                  className="volt-chain__type-badge"
                  style={{ background: color.bg, color: color.fg }}
                >
                  {evt.event_type}
                </span>
                <span className="volt-chain__actor">
                  {evt.actor?.actor_id || evt.actor?.actor_type || '—'}
                </span>
                <span className="volt-chain__time">{formatEventTime(evt.ts)}</span>
              </div>

              {/* Hash chain link */}
              <div className="volt-chain__hash-link">
                <span>{truncHash(evt.prev_hash)}</span>
                <span className="volt-chain__hash-arrow">→</span>
                <span>{truncHash(evt.hash)}</span>
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div className="volt-chain__expanded">
                  <div className="volt-chain__detail-row">
                    <div className="volt-chain__detail-label">Event ID</div>
                    <div className="volt-chain__detail-value">{evt.event_id}</div>
                  </div>
                  <div className="volt-chain__detail-row">
                    <div className="volt-chain__detail-label">Full Hash</div>
                    <div className="volt-chain__detail-value">{evt.hash}</div>
                  </div>
                  <div className="volt-chain__detail-row">
                    <div className="volt-chain__detail-label">Previous Hash</div>
                    <div className="volt-chain__detail-value">{evt.prev_hash}</div>
                  </div>
                  {evt.context && (
                    <div className="volt-chain__detail-row">
                      <div className="volt-chain__detail-label">Context</div>
                      <div className="volt-chain__json">
                        {JSON.stringify(evt.context, null, 2)}
                      </div>
                    </div>
                  )}
                  {evt.payload && Object.keys(evt.payload).length > 0 && (
                    <div className="volt-chain__detail-row">
                      <div className="volt-chain__detail-label">Payload</div>
                      <div className="volt-chain__json">
                        {JSON.stringify(evt.payload, null, 2)}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}

      {hasMore && (
        <div className="volt-chain__load-more">
          <button
            className="volt-btn"
            onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
          >
            Load more ({events.length - visibleCount} remaining)
          </button>
        </div>
      )}
    </div>
  )
}
