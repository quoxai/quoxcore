/**
 * LiveEventStream — Hero real-time WebSocket event feed.
 *
 * Connects to QuoxAgent at /mha-agent/ws/agents/events.
 * Features:
 * - Active session cards strip with live status
 * - Activity sparkline showing event rate
 * - Filter chips by event type
 * - Terminal-style scrolling feed with colour-coded events
 * - Click session to filter events
 */

import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'

const getWsUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/mha-agent/ws/agents/events`
}

const EVENT_CONFIG = {
  'session.start':        { icon: '\u25B6', color: '#22c55e', label: 'Session Started', group: 'session' },
  'session.end':          { icon: '\u25A0', color: '#6b7280', label: 'Session Ended',   group: 'session' },
  'session.status':       { icon: '\u21BB', color: '#f59e0b', label: 'Status Change',   group: 'session' },
  'activity.tool_call':   { icon: '\u26A1', color: '#eab308', label: 'Tool Call',       group: 'activity' },
  'activity.tool_result': { icon: '\u2191', color: '#84cc16', label: 'Tool Result',     group: 'activity' },
  'delegation.accepted':  { icon: '\u21AA', color: '#818cf8', label: 'Delegating',      group: 'activity' },
  'delegation.completed': { icon: '\u21A9', color: '#6366f1', label: 'Delegation Result', group: 'activity' },
  'activity.file_change': { icon: '\u270E', color: '#a855f7', label: 'File Change',     group: 'activity' },
  'activity.message':     { icon: '\u25AC', color: '#06b6d4', label: 'Message',         group: 'activity' },
  'activity.thinking':    { icon: '\u2026', color: '#3b82f6', label: 'Thinking',        group: 'activity' },
  'activity.code_exec':   { icon: '\u25B8', color: '#f97316', label: 'Code Exec',       group: 'activity' },
  'output.stdout':        { icon: '\u2192', color: '#6b7280', label: 'Output',          group: 'output' },
  'output.stderr':        { icon: '\u2717', color: '#ef4444', label: 'Error',           group: 'output' },
  'metrics.tokens':       { icon: '#',      color: '#8b5cf6', label: 'Tokens',          group: 'metrics' },
  'metrics.cost':         { icon: '$',      color: '#10b981', label: 'Cost',            group: 'metrics' },
}

const PROVIDER_COLORS = { anthropic: '#d97706', openai: '#10b981', google: '#4285f4', local: '#6b7280' }

const FILTER_GROUPS = [
  { id: 'all',      label: 'All' },
  { id: 'activity', label: 'Activity' },
  { id: 'session',  label: 'Sessions' },
  { id: 'output',   label: 'Output' },
]

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(ms) {
  if (!ms) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// ── Activity Sparkline ───────────────────────────────────────────────────────
// Shows event rate over last 60 seconds as a mini bar chart

function ActivitySparkline({ events }) {
  const bars = useMemo(() => {
    const now = Date.now()
    const buckets = new Array(30).fill(0) // 30 buckets of 2s each = 60s window
    events.forEach(e => {
      const age = (now - new Date(e.timestamp).getTime()) / 1000
      if (age < 60) {
        const bucket = Math.min(29, Math.floor(age / 2))
        buckets[bucket]++
      }
    })
    const max = Math.max(1, ...buckets)
    return buckets.reverse().map(count => count / max)
  }, [events])

  return (
    <div className="les-spark">
      {bars.map((h, i) => (
        <div key={i} className="les-spark__bar" style={{ height: `${Math.max(2, h * 100)}%`, opacity: h > 0 ? 0.4 + h * 0.6 : 0.1 }} />
      ))}
    </div>
  )
}

// ── Session Card ─────────────────────────────────────────────────────────────

const SessionCard = memo(function SessionCard({ session, isSelected, onClick }) {
  const isActive = ['running', 'starting', 'idle', 'waiting'].includes(session.status)
  const duration = isActive ? Date.now() - new Date(session.started_at).getTime() : (session.duration_ms || 0)
  const providerColor = PROVIDER_COLORS[session.provider] || '#6b7280'

  return (
    <button
      className={`les-session ${isSelected ? 'les-session--selected' : ''} ${isActive ? 'les-session--active' : ''}`}
      onClick={onClick}
      title={`${session.agent_name} on ${session.host_id}, click to filter events`}
    >
      <div className="les-session__top">
        <span className={`les-session__dot ${isActive ? 'les-session__dot--live' : ''}`} style={{ background: isActive ? '#30ff90' : '#444' }} />
        <span className="les-session__host">{session.host_id}</span>
      </div>
      <div className="les-session__agent" style={{ color: providerColor }}>{session.agent_name || session.agent_type}</div>
      <div className="les-session__meta">
        <span>{formatDuration(duration)}</span>
        {session.tool_call_count > 0 && <span>{session.tool_call_count} tools</span>}
        {session.files_modified > 0 && <span>{session.files_modified} files</span>}
      </div>
    </button>
  )
})

// ── Event Row ────────────────────────────────────────────────────────────────

const EventRow = memo(function EventRow({ event }) {
  const [expanded, setExpanded] = useState(false)
  const config = EVENT_CONFIG[event.type] || { icon: '\u2022', color: '#6b7280', label: event.type }

  // Extract useful detail from event data
  let detail = event.summary || config.label
  if (event.type === 'activity.tool_call' && event.data?.tool_name) {
    detail = `${event.data.tool_name}${event.data.tool_input ? ': ' + String(event.data.tool_input).slice(0, 60) : ''}`
  } else if (event.type === 'activity.file_change' && event.data?.file) {
    detail = event.data.file
  } else if (event.type === 'delegation.accepted' && event.data?.target) {
    detail = `${event.data.parent || 'quox'} → ${event.data.target}${event.data.task ? ': ' + String(event.data.task).slice(0, 80) : ''}`
  } else if (event.type === 'delegation.completed' && event.data?.target) {
    detail = `${event.data.target} → ${event.data.parent || 'quox'} ${event.data.success === false ? '✗' : '✓'}${Array.isArray(event.data.tools_used) && event.data.tools_used.length ? ' · ' + event.data.tools_used.join(', ') : ''}`
  }

  const hasDetail = event.data && Object.keys(event.data).length > 0

  return (
    <div className={`les-event ${expanded ? 'les-event--expanded' : ''} ${hasDetail ? 'les-event--clickable' : ''}`}>
      <button
        type="button"
        className="les-event__row"
        onClick={() => hasDetail && setExpanded(v => !v)}
        disabled={!hasDetail}
      >
        <span className="les-event__chevron">{hasDetail ? (expanded ? '\u25BE' : '\u25B8') : ' '}</span>
        <span className="les-event__time">{formatTime(event.timestamp)}</span>
        <span className="les-event__icon" style={{ color: config.color }}>{config.icon}</span>
        <span className="les-event__source">{event.host_id || 'local'}</span>
        <span className="les-event__sep">/</span>
        <span className="les-event__agent" style={{ color: config.color }}>{event.agent_name || 'agent'}</span>
        <span className="les-event__detail">{detail}</span>
      </button>
      {expanded && hasDetail && (
        <pre className="les-event__payload">{JSON.stringify(event.data, null, 2)}</pre>
      )}
    </div>
  )
})

// ── Main Component ───────────────────────────────────────────────────────────

export default function LiveEventStream() {
  const [connected, setConnected] = useState(false)
  const [sessions, setSessions] = useState([])
  const [events, setEvents] = useState([])
  const [isPaused, setIsPaused] = useState(false)
  const [filterGroup, setFilterGroup] = useState('all')
  const [filterSessionId, setFilterSessionId] = useState(null)

  const wsRef = useRef(null)
  const reconnectRef = useRef(null)
  const eventListRef = useRef(null)

  const handleMessage = useCallback((data) => {
    if (data.type === 'session_start' && data.session) {
      setSessions(prev => {
        const idx = prev.findIndex(s => s.id === data.session.id)
        if (idx >= 0) { const u = [...prev]; u[idx] = data.session; return u }
        return [data.session, ...prev]
      })
    } else if (data.type === 'session_end' && data.session) {
      setSessions(prev => prev.map(s => s.id === data.session.id ? { ...s, ...data.session } : s))
    } else if (data.type === 'event' && data.event) {
      setEvents(prev => [data.event, ...prev].slice(0, 300))
      if (data.event.session_id) {
        setSessions(prev => prev.map(s => {
          if (s.id !== data.event.session_id) return s
          const u = { ...s, last_active: data.event.timestamp }
          if (data.event.type === 'activity.tool_call') u.tool_call_count = (s.tool_call_count || 0) + 1
          if (data.event.type === 'activity.file_change') u.files_modified = (s.files_modified || 0) + 1
          if (data.event.type === 'activity.message') u.message_count = (s.message_count || 0) + 1
          return u
        }))
      }
    }
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    try {
      const ws = new WebSocket(getWsUrl())
      ws.onopen = () => setConnected(true)
      ws.onmessage = (ev) => {
        try { ev.data.split('\n').filter(Boolean).forEach(msg => handleMessage(JSON.parse(msg))) } catch {}
      }
      ws.onclose = () => { setConnected(false); wsRef.current = null; reconnectRef.current = setTimeout(connect, 5000) }
      ws.onerror = () => setConnected(false)
      wsRef.current = ws
    } catch { reconnectRef.current = setTimeout(connect, 5000) }
  }, [handleMessage])

  useEffect(() => {
    connect()
    fetch(`${window.location.origin}/mha-agent/api/v1/agents/sessions`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.sessions) setSessions(data.sessions) })
      .catch(() => {})
    return () => { clearTimeout(reconnectRef.current); wsRef.current?.close() }
  }, [connect])

  useEffect(() => {
    if (!isPaused && eventListRef.current) eventListRef.current.scrollTop = 0
  }, [events, isPaused])

  // Filtered events
  const filteredEvents = useMemo(() => {
    return events.filter(e => {
      if (filterSessionId && e.session_id !== filterSessionId) return false
      if (filterGroup !== 'all') {
        const config = EVENT_CONFIG[e.type]
        if (config && config.group !== filterGroup) return false
      }
      return true
    })
  }, [events, filterGroup, filterSessionId])

  // Split sessions
  const activeSessions = useMemo(() =>
    sessions.filter(s => ['running', 'starting', 'idle', 'waiting'].includes(s.status)),
    [sessions]
  )
  const recentSessions = useMemo(() =>
    sessions.filter(s => !['running', 'starting', 'idle', 'waiting'].includes(s.status)).slice(0, 5),
    [sessions]
  )
  const allVisibleSessions = [...activeSessions, ...recentSessions]

  return (
    <div className="les-panel">
      {/* Header */}
      <div className="les-header">
        <div className="les-header__left">
          <span className={`les-dot ${connected ? 'les-dot--live' : ''}`} />
          <span className="les-header__title">QuoxAgent Event Stream</span>
          {activeSessions.length > 0 && (
            <span className="les-header__active">{activeSessions.length} live</span>
          )}
        </div>
        <div className="les-header__right">
          <ActivitySparkline events={events} />
          {/* Pause/Resume: freezes the auto-scroll-to-top so a row can be read.
              The isPaused state + PAUSED badge already existed but had no control. */}
          <button
            type="button"
            onClick={() => setIsPaused(p => !p)}
            title={isPaused ? 'Resume auto-scroll' : 'Pause auto-scroll'}
            aria-label={isPaused ? 'Resume live event stream' : 'Pause live event stream'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px',
              fontSize: 11, fontWeight: 600, cursor: 'pointer', color: '#fff',
              background: 'var(--m-bg-base, rgba(255,255,255,0.06))',
              border: '1px solid var(--m-border-default, rgba(255,255,255,0.14))',
              borderRadius: 6,
            }}
          >
            {isPaused ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            )}
            {isPaused ? 'Resume' : 'Pause'}
          </button>
          {isPaused && <span className="les-header__paused">PAUSED</span>}
          <span className="les-header__count">{filteredEvents.length}</span>
        </div>
      </div>
      <div className="les-subtitle">
        Live activity from connected QuoxAgents. Click a session to filter, a chip to narrow, or a row to expand its payload.
      </div>

      {/* Active sessions strip */}
      {allVisibleSessions.length > 0 && (
        <div className="les-sessions-strip">
          {filterSessionId && (
            <button className="les-session les-session--clear" onClick={() => setFilterSessionId(null)}>
              <span className="les-session__clear-x">{'\u2715'}</span>
              <span>Clear filter</span>
            </button>
          )}
          {allVisibleSessions.map(s => (
            <SessionCard
              key={s.id}
              session={s}
              isSelected={filterSessionId === s.id}
              onClick={() => setFilterSessionId(prev => prev === s.id ? null : s.id)}
            />
          ))}
        </div>
      )}

      {/* Filter chips */}
      <div className="les-filters">
        {FILTER_GROUPS.map(g => (
          <button
            key={g.id}
            className={`les-filter ${filterGroup === g.id ? 'les-filter--active' : ''}`}
            onClick={() => setFilterGroup(g.id)}
          >{g.label}</button>
        ))}
      </div>

      {/* Event feed */}
      <div
        className="les-events"
        ref={eventListRef}
      >
        {filteredEvents.length === 0 && (
          <div className="les-empty">
            {!connected
              ? 'Connecting to QuoxAgent event stream...'
              : events.length === 0
                ? 'Listening for events. Start an AI session or submit a job to see activity here.'
                : 'No events match the current filter.'}
          </div>
        )}
        {filteredEvents.map((event, i) => (
          <EventRow key={event.id || `${event.timestamp}-${i}`} event={event} />
        ))}
      </div>

      <div className="les-scanline" />
    </div>
  )
}
