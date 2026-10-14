/**
 * QUOXCHAT-PRO: Live Support desk ("/live-support").
 *
 * The Rooms-style live operator experience rebuilt on Matrix-free plumbing.
 * Backed ONLY by the org-authed conversation APIs (list conversations,
 * transcript, operator-reply), so it works identically on deployments with
 * no Matrix stack: on those installs this view IS the whole live desk. When
 * a conversation does carry a matrix_room_id (Matrix installs mint one at
 * handoff), an "Open in Matrix room" affordance deep-links into
 * /matrix-comms with quoxchatRoomId state; Rooms gates availability there.
 *
 * Left column (owner's Logs critique is the spec): two-line rows. Line one:
 * visitor name (or a decent short id, never cropped mid-word) + status
 * badge (Waiting amber pulsing when the last message is the visitor's,
 * Answered green, AI active dim). Line two: last-message preview + relative
 * time and date (Today 14:32 / Yesterday 09:10 / 22 Jul). Widget selector
 * on top when the org has several widgets, "N waiting" pill in the header,
 * sorted by last activity.
 *
 * Right: transcript as chat bubbles (visitor left, AI dim, operator
 * green-tinted right), reply composer pinned bottom, optimistic send with a
 * Delivered state. 9s poll while open; polling pauses whenever the tab is
 * hidden (document.visibilityState).
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { renderMarkdown } from '../../widget/widgetComms'
import './live-support.css'

const POLL_MS = 9000

// SQLite datetime('now') rows come back as UTC "YYYY-MM-DD HH:MM:SS"
// without a timezone marker; normalise before parsing so relative dates
// don't drift by the browser's offset.
function parseTs(value) {
  if (!value) return null
  if (typeof value === 'number') return new Date(value)
  let s = String(value)
  if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T')
  if (!/([zZ]|[+-]\d\d:?\d\d)$/.test(s)) s += 'Z'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

// "Today 14:32" / "Yesterday 09:10" / "22 Jul" / "22 Jul 2025"
function formatWhen(value) {
  const d = parseTs(value)
  if (!d) return ''
  const now = new Date()
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, now)) return `Today ${hm}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, yesterday)) return `Yesterday ${hm}`
  const dayMonth = d.toLocaleDateString([], { day: 'numeric', month: 'short' })
  if (d.getFullYear() === now.getFullYear()) return dayMonth
  return `${dayMonth} ${d.getFullYear()}`
}

// Visitor display name precedence: the pre-handoff form name
// (widget_conversations.visitor_name, migration 086), then the identify()
// attrs captured in widget_visitors, then email, then a short readable id.
function visitorDisplay(row) {
  if (!row || typeof row !== 'object') return 'Visitor'
  if (row.visitor_name && String(row.visitor_name).trim()) return String(row.visitor_name).trim()
  let attrs = {}
  if (row.visitor_identified_attrs_json) {
    try {
      const parsed = JSON.parse(row.visitor_identified_attrs_json)
      if (parsed && typeof parsed === 'object') attrs = parsed
    } catch (_) { /* malformed attrs, fall through */ }
  }
  const name = attrs.name || [attrs.first_name, attrs.last_name].filter(Boolean).join(' ')
  if (name) return name
  if (row.visitor_email) return String(row.visitor_email)
  if (attrs.email) return String(attrs.email)
  const raw = String(row.visitor_id || '').replace(/^(visitor[-_]?|qc[-_]?)/i, '')
  return raw ? `Visitor ${raw.slice(0, 8)}` : 'Visitor'
}

// Desk status. A handed-off conversation that no operator has joined yet is
// WAITING regardless of who spoke last: the AI's handoff ack is always the
// last message right after a handoff, and keying purely off the last turn
// made every fresh handoff read as "AI active" with a 0-waiting pill
// (night-audit finding, 2026-07-25, conv XAN6CT94 evidence). Otherwise the
// last transcript turn decides: customer spoke last means waiting, operator
// spoke last means answered, anything else means the AI is holding it.
function convDeskStatus(row) {
  if (row?.status === 'handed_off') {
    if (!row?.operator_joined_at) return 'waiting'
    return row?.last_message_role === 'user' ? 'waiting' : 'answered'
  }
  if (row?.last_message_role === 'user') return 'waiting'
  if (row?.last_message_role === 'operator') return 'answered'
  return 'ai'
}

const STATUS_LABEL = { waiting: 'Waiting', answered: 'Answered', ai: 'AI active' }

function StatusBadge({ status }) {
  return <span className={`ls-status ls-status--${status}`}>{STATUS_LABEL[status]}</span>
}

function lastActivity(row) {
  return parseTs(row?.last_message_at || row?.started_at || row?.created_at)?.getTime() || 0
}

export default function LiveSupportView() {
  const navigate = useNavigate()
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id

  const [widgets, setWidgets] = useState([])
  const [widgetsLoaded, setWidgetsLoaded] = useState(false)
  const [widgetId, setWidgetId] = useState('')
  const [conversations, setConversations] = useState([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [messages, setMessages] = useState([])
  const [msgLoading, setMsgLoading] = useState(false)
  const [replyDraft, setReplyDraft] = useState('')
  const [replySending, setReplySending] = useState(false)
  const [replyError, setReplyError] = useState(null)
  const [deliveredId, setDeliveredId] = useState(null)
  const transcriptRef = useRef(null)

  const selectedConv = useMemo(
    () => conversations.find(c => c.id === selectedId) || null,
    [conversations, selectedId],
  )

  // ── Widgets ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!authFetch || !orgId) return
    let cancelled = false
    authFetch(`/api/orgs/${orgId}/widgets`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => {
        if (cancelled) return
        const rows = Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
        setWidgets(rows)
        setWidgetId(prev => prev && rows.some(w => w.id === prev) ? prev : (rows[0]?.id || ''))
      })
      .catch(() => { if (!cancelled) setWidgets([]) })
      .finally(() => { if (!cancelled) setWidgetsLoaded(true) })
    return () => { cancelled = true }
  }, [authFetch, orgId])

  // ── Conversation list (load + 9s poll, paused when tab hidden) ─────────
  const loadConversations = useCallback(async ({ silent = false } = {}) => {
    if (!authFetch || !orgId || !widgetId) return
    if (!silent) { setListLoading(true); setListError(null) }
    try {
      const r = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/conversations?limit=100&exclude_test=1`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      const rows = Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
      rows.sort((a, b) => lastActivity(b) - lastActivity(a))
      setConversations(rows)
    } catch (err) {
      if (!silent) setListError(err.message)
    } finally {
      if (!silent) setListLoading(false)
    }
  }, [authFetch, orgId, widgetId])

  useEffect(() => {
    setConversations([])
    setSelectedId(null)
    setMessages([])
    loadConversations()
  }, [loadConversations])

  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') loadConversations({ silent: true }) }
    const interval = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', tick) }
  }, [loadConversations])

  // ── Transcript (load on select + 9s poll, paused when tab hidden) ──────
  const loadMessages = useCallback(async (convId, { silent = false } = {}) => {
    if (!authFetch || !orgId || !widgetId || !convId) return
    if (!silent) setMsgLoading(true)
    try {
      const r = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/conversations/${convId}/messages`)
      if (!r.ok) return
      const data = await r.json()
      if (Array.isArray(data?.messages)) setMessages(data.messages)
    } catch (_) { /* non-fatal, next tick retries */ }
    finally { if (!silent) setMsgLoading(false) }
  }, [authFetch, orgId, widgetId])

  useEffect(() => {
    if (!selectedId) return
    setMessages([])
    setReplyDraft('')
    setReplyError(null)
    setDeliveredId(null)
    loadMessages(selectedId)
    const tick = () => { if (document.visibilityState === 'visible') loadMessages(selectedId, { silent: true }) }
    const interval = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', tick) }
  }, [selectedId, loadMessages])

  // Keep the transcript pinned to the latest message.
  useEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, selectedId])

  // ── Reply (optimistic send + Delivered state) ──────────────────────────
  const handleSendReply = async () => {
    const text = replyDraft.trim()
    if (!text || replySending || !selectedConv || !authFetch || !orgId || !widgetId) return
    setReplySending(true)
    setReplyError(null)
    const localId = `local-${Date.now()}`
    setMessages(msgs => [...msgs, {
      id: localId, role: 'operator', content: text,
      sender_name: null, created_at: new Date().toISOString(), pending: true,
    }])
    setReplyDraft('')
    try {
      const r = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/conversations/${selectedConv.id}/operator-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || data.success === false) throw new Error(data.error || `Reply failed (${r.status})`)
      const serverId = data.message_id || localId
      setMessages(msgs => msgs.map(m => m.id === localId
        ? { ...m, id: serverId, sender_name: data.sender_name || null, pending: false }
        : m))
      setDeliveredId(serverId)
      loadConversations({ silent: true })
    } catch (err) {
      setMessages(msgs => msgs.filter(m => m.id !== localId))
      setReplyDraft(text)
      setReplyError(err.message)
    } finally {
      setReplySending(false)
    }
  }

  const waitingCount = useMemo(
    () => conversations.filter(c => convDeskStatus(c) === 'waiting').length,
    [conversations],
  )

  const canReply = selectedConv?.status === 'handed_off'
  const selectedName = selectedConv ? visitorDisplay(selectedConv) : ''

  return (
    <div className="qx-view live-support-theme">
      <div className="qx-card ls-shell" style={{ padding: 20 }}>
        {/* ── Left: conversation list ─────────────────────────────────── */}
        <div className="ls-col-left">
          <div className="ls-header">
            <h2 className="ls-title">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
              </svg>
              Live Support
            </h2>
            <span className={`ls-wait-pill${waitingCount > 0 ? ' ls-wait-pill--hot' : ''}`}>
              {waitingCount} waiting
            </span>
          </div>

          {widgets.length > 1 && (
            <select
              className="glass-input"
              aria-label="Select widget"
              value={widgetId}
              onChange={e => setWidgetId(e.target.value)}
              style={{ fontSize: 12, padding: '6px 10px' }}
            >
              {widgets.map(w => (
                <option key={w.id} value={w.id}>{w.name || w.id}</option>
              ))}
            </select>
          )}

          <div className="ls-conv-list">
            {conversations.map(c => {
              const status = convDeskStatus(c)
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`ls-conv-row${c.id === selectedId ? ' active' : ''}`}
                  onClick={() => setSelectedId(c.id)}
                >
                  <div className="ls-conv-line1">
                    <span className="ls-conv-name">{visitorDisplay(c)}</span>
                    <StatusBadge status={status} />
                  </div>
                  <div className="ls-conv-line2">
                    <span className="ls-conv-preview">
                      {c.last_message_preview || `${c.message_count || 0} messages`}
                    </span>
                    <span className="ls-conv-time">{formatWhen(c.last_message_at || c.started_at || c.created_at)}</span>
                  </div>
                </button>
              )
            })}
            {(listLoading || !widgetsLoaded) && conversations.length === 0 && (
              <div className="ls-empty">Loading conversations...</div>
            )}
            {widgetsLoaded && !listLoading && !listError && conversations.length === 0 && (
              <div className="ls-empty">
                {widgetsLoaded && widgets.length === 0
                  ? 'No QuoxChat widgets yet. Create one in QuoxChat to open the live desk.'
                  : 'No conversations yet. Visitor chats appear here the moment they start.'}
              </div>
            )}
            {listError && (
              <div className="ls-empty" style={{ color: '#ef4444' }}>Failed to load: {listError}</div>
            )}
          </div>
        </div>

        {/* ── Right: transcript + composer ────────────────────────────── */}
        <div className="ls-col-right">
          {selectedConv ? (
            <>
              <div className="ls-room-header">
                <span className="ls-room-title">{selectedName}</span>
                <StatusBadge status={convDeskStatus(selectedConv)} />
                {/* Matrix upgrade affordance: only rendered when this
                    deployment minted a governed room for the conversation.
                    Matrix-less installs never set matrix_room_id, so no
                    dead ends; Rooms gates availability on its side. */}
                {selectedConv.matrix_room_id && (
                  <button
                    type="button"
                    className="ls-matrix-btn"
                    title="Open the governed Matrix room for this conversation"
                    onClick={() => navigate('/matrix-comms', {
                      state: { quoxchatRoomId: selectedConv.matrix_room_id, conversationId: selectedConv.id },
                    })}
                  >
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
                    </svg>
                    Open in Matrix room
                  </button>
                )}
              </div>

              <div className="ls-transcript" ref={transcriptRef}>
                {msgLoading && messages.length === 0 && (
                  <div className="ls-empty">Loading transcript...</div>
                )}
                {messages.map(m => {
                  const kind = m.role === 'user' ? 'visitor' : m.role === 'operator' ? 'operator' : 'ai'
                  const who = kind === 'visitor'
                    ? selectedName
                    : kind === 'operator' ? (m.sender_name || 'You') : 'AI assistant'
                  return (
                    <div key={m.id} className={`ls-bubble ls-bubble--${kind}`}>
                      <div className="ls-bubble-meta">
                        {who} · {formatWhen(m.created_at)}
                        {m.pending && <span> · Sending...</span>}
                        {!m.pending && m.id === deliveredId && <span className="ls-delivered"> · Delivered</span>}
                      </div>
                      {kind === 'ai'
                        ? <span dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content || '') }} />
                        : (m.content || '')}
                    </div>
                  )
                })}
              </div>

              <div className="ls-composer">
                {!canReply && (
                  <span className="ls-composer-hint">
                    The AI is handling this conversation. Replies unlock when the visitor asks for a human (handed off).
                  </span>
                )}
                <div className="ls-composer-row">
                  <textarea
                    aria-label="Reply to the visitor"
                    rows={2}
                    placeholder="Reply to the visitor..."
                    value={replyDraft}
                    disabled={!canReply}
                    onChange={e => setReplyDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendReply() } }}
                  />
                  <button
                    type="button"
                    className="ls-send-btn"
                    disabled={!canReply || replySending || !replyDraft.trim()}
                    title="Send this reply to the visitor's chat widget"
                    onClick={handleSendReply}
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                    </svg>
                    {replySending ? 'Sending...' : 'Send'}
                  </button>
                </div>
                {replyError && <span className="ls-composer-error">Reply failed: {replyError}</span>}
              </div>
            </>
          ) : (
            <div className="ls-empty">
              Select a conversation to open the live transcript.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
