/**
 * VoltEventsTable — Sortable, filterable data table for run events
 *
 * Columns: Seq | Type | Actor | Timestamp | Hash | Payload
 * Click row to expand inline details.
 *
 * GLV-5: migrated to glass-primitives (GlassPanel + COLORS tokens).
 */

import { useState, useMemo } from 'react'
import { GlassPanel, COLORS, M } from '../compliance/glass-primitives'

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

const DEFAULT_COLOR = { bg: 'rgba(100, 116, 139, 0.15)', fg: '#94a3b8' }

function truncHash(hash) {
  if (!hash) return '—'
  return hash.slice(0, 8) + '…' + hash.slice(-6)
}

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const SortArrow = ({ dir }) => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"
    style={{ transform: dir === 'desc' ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
    <polyline points="18 15 12 9 6 15" />
  </svg>
)

const glassInputStyle = {
  fontFamily: M, fontSize: 11, color: '#fff',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 8, padding: '6px 10px', outline: 'none',
}

const GRID = '56px 1fr 140px 100px 160px'

export default function VoltEventsTable({ events = [] }) {
  const [sortCol, setSortCol] = useState('seq')
  const [sortDir, setSortDir] = useState('asc')
  const [typeFilter, setTypeFilter] = useState('')
  const [expandedId, setExpandedId] = useState(null)

  const eventTypes = useMemo(() => {
    const types = new Set(events.map(e => e.event_type))
    return Array.from(types).sort()
  }, [events])

  const sorted = useMemo(() => {
    let filtered = typeFilter
      ? events.filter(e => e.event_type === typeFilter)
      : events

    return [...filtered].sort((a, b) => {
      let cmp = 0
      switch (sortCol) {
        case 'seq': cmp = (a.seq || 0) - (b.seq || 0); break
        case 'type': cmp = (a.event_type || '').localeCompare(b.event_type || ''); break
        case 'actor': {
          const aa = a.actor?.actor_id || a.actor?.actor_type || ''
          const ba = b.actor?.actor_id || b.actor?.actor_type || ''
          cmp = aa.localeCompare(ba)
          break
        }
        case 'ts': cmp = (a.ts || '').localeCompare(b.ts || ''); break
        default: cmp = 0
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [events, sortCol, sortDir, typeFilter])

  const toggleSort = (col) => {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  const columns = [
    { key: 'seq', label: 'Seq' },
    { key: 'type', label: 'Type' },
    { key: 'actor', label: 'Actor' },
    { key: 'ts', label: 'Timestamp' },
    { key: 'hash', label: 'Hash', sortable: false },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Type filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          style={{ ...glassInputStyle, minWidth: 220, cursor: 'pointer' }}
        >
          <option value="" style={{ background: '#1a1a2e' }}>All types ({events.length})</option>
          {eventTypes.map(t => (
            <option key={t} value={t} style={{ background: '#1a1a2e' }}>{t}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <GlassPanel style={{ padding: 0, overflow: 'hidden' }}>
        {/* Header */}
        <div style={{
          display: 'grid', gridTemplateColumns: GRID, gap: 10,
          padding: '10px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(255,255,255,0.02)',
        }}>
          {columns.map(col => {
            const sortable = col.sortable !== false
            const active = sortCol === col.key && sortable
            return (
              <div
                key={col.key}
                onClick={sortable ? () => toggleSort(col.key) : undefined}
                style={{
                  fontFamily: M, fontSize: 9, fontWeight: 700, letterSpacing: 1,
                  color: active ? '#fff' : COLORS.dimText,
                  textTransform: 'uppercase',
                  display: 'flex', alignItems: 'center', gap: 4,
                  cursor: sortable ? 'pointer' : 'default',
                  userSelect: 'none',
                }}
              >
                {col.label}
                {active && <SortArrow dir={sortDir} />}
              </div>
            )
          })}
        </div>

        {/* Rows */}
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {sorted.length === 0 && (
            <div style={{
              padding: 24, textAlign: 'center',
              fontFamily: M, fontSize: 11, color: COLORS.dimText,
            }}>No events match the current filter.</div>
          )}
          {sorted.map((evt, i) => {
            const color = EVENT_COLORS[evt.event_type] || DEFAULT_COLOR
            const isExpanded = expandedId === evt.event_id

            return (
              <div key={evt.event_id}>
                <div
                  onClick={() => setExpandedId(isExpanded ? null : evt.event_id)}
                  style={{
                    display: 'grid', gridTemplateColumns: GRID, gap: 10,
                    padding: '8px 14px',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    background: isExpanded
                      ? 'rgba(255,255,255,0.04)'
                      : i % 2 ? 'rgba(255,255,255,0.015)' : 'transparent',
                    cursor: 'pointer', alignItems: 'center',
                    transition: 'background 0.15s',
                  }}
                >
                  <div style={{
                    fontFamily: M, fontSize: 10, color: COLORS.dimText,
                    fontVariantNumeric: 'tabular-nums',
                  }}>{evt.seq}</div>
                  <div style={{ minWidth: 0 }}>
                    <span style={{
                      fontFamily: M, fontSize: 9, fontWeight: 600, letterSpacing: 0.5,
                      padding: '2px 8px', borderRadius: 4,
                      background: color.bg, color: color.fg,
                      display: 'inline-block', maxWidth: '100%',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {evt.event_type}
                    </span>
                  </div>
                  <div style={{
                    fontFamily: M, fontSize: 10, color: '#fff',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {evt.actor?.actor_id || evt.actor?.actor_type || '—'}
                  </div>
                  <div style={{
                    fontFamily: M, fontSize: 10, color: COLORS.dimText,
                    fontVariantNumeric: 'tabular-nums',
                  }}>{formatTime(evt.ts)}</div>
                  <div style={{
                    fontFamily: M, fontSize: 10, color: COLORS.dimText,
                    fontVariantNumeric: 'tabular-nums',
                  }} title={evt.hash}>{truncHash(evt.hash)}</div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={{
                    padding: '12px 18px',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    background: 'rgba(0,0,0,0.15)',
                    display: 'flex', flexDirection: 'column', gap: 8,
                  }}>
                    <DetailRow label="Event ID" value={evt.event_id} />
                    <DetailRow label="Full Hash" value={evt.hash} />
                    <DetailRow label="Prev Hash" value={evt.prev_hash} />
                    {evt.payload && Object.keys(evt.payload).length > 0 && (
                      <DetailRow
                        label="Payload"
                        value={(
                          <pre style={{
                            fontFamily: M, fontSize: 10, color: '#fff',
                            background: 'rgba(0,0,0,0.3)', padding: 10, borderRadius: 6,
                            margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            maxHeight: 220, overflowY: 'auto',
                          }}>
                            {JSON.stringify(evt.payload, null, 2)}
                          </pre>
                        )}
                      />
                    )}
                    {evt.context && (
                      <DetailRow
                        label="Context"
                        value={(
                          <pre style={{
                            fontFamily: M, fontSize: 10, color: '#fff',
                            background: 'rgba(0,0,0,0.3)', padding: 10, borderRadius: 6,
                            margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            maxHeight: 220, overflowY: 'auto',
                          }}>
                            {JSON.stringify(evt.context, null, 2)}
                          </pre>
                        )}
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </GlassPanel>
    </div>
  )
}

function DetailRow({ label, value }) {
  const isBlock = typeof value !== 'string'
  return (
    <div style={{
      display: isBlock ? 'flex' : 'grid',
      flexDirection: isBlock ? 'column' : undefined,
      gridTemplateColumns: isBlock ? undefined : '120px 1fr',
      gap: isBlock ? 4 : 12, alignItems: 'flex-start',
    }}>
      <span style={{
        fontFamily: M, fontSize: 9, fontWeight: 600, letterSpacing: 1,
        color: COLORS.dimText, textTransform: 'uppercase', paddingTop: isBlock ? 0 : 2,
      }}>{label}</span>
      {isBlock ? value : (
        <span style={{
          fontFamily: M, fontSize: 10, color: '#fff',
          wordBreak: 'break-all',
        }}>{value}</span>
      )}
    </div>
  )
}
