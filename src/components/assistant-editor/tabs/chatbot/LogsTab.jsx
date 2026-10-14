/**
 * LogsTab — Conversation history with message playback (CW-11.2 v2)
 *
 * Adds status / rating / date filters, tool_calls per-message display, JSON
 * export, correlation-id surfacing.
 */

import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatConversation, formatMessage, exportToCSV } from '../../../../widget/logsUtils'
import { formatSourceAttribution, getConfidenceBadge } from '../../../../widget/trainingUtils'
import { renderMarkdown } from '../../../../widget/widgetComms'
import MessageContextPanel from './MessageContextPanel'

// B5/B7 audit fixes: day-aware time labels ("Today 5:51 pm", "Yesterday 6:03
// pm", else "22 Jul, 5:51 pm") shared by the conversation list row and the
// transcript. Kept local to LogsTab rather than logsUtils.js so the raw
// created_at/last_message_at timestamps drive both the label and the day
// dividers below from a single source of truth.
function formatDayAwareTime(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const startOfDay = dt => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  if (dayDiff === 0) return `Today ${time}`
  if (dayDiff === 1) return `Yesterday ${time}`
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`
}

// Day-divider label ("Today" / "Yesterday" / "22 Jul 2026") for the
// transcript, used whenever the day changes between two consecutive
// messages.
function formatDayDivider(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const startOfDay = dt => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (dayDiff === 0) return 'Today'
  if (dayDiff === 1) return 'Yesterday'
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

// P2 "Logs list upgrade": day-divider label for the conversation LIST
// (distinct from the transcript's formatDayDivider, which spells out the
// full date with a year). The list only needs to distinguish recent days,
// so older rows get a short "Mon 21 Jul" style label with no year.
function formatListDayLabel(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const startOfDay = dt => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (dayDiff === 0) return 'Today'
  if (dayDiff === 1) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')
}

// Plain-language status labels for the conversation status chip (task B7 /
// exec 7). Raw machine value is kept in the chip's title attribute.
const STATUS_LABELS = {
  active: 'Active',
  resolved: 'Resolved',
  handed_off: 'Waiting for teammate',
  abandoned: 'Abandoned',
  closed: 'Closed',
}
function formatStatusLabel(status) {
  return STATUS_LABELS[status] || status
}

// Sorts messages chronologically ascending — the transcript API order is not
// guaranteed to match created_at order (B5).
function sortMessagesByTime(msgs) {
  return [...msgs].sort((a, b) => new Date(a?.created_at || 0) - new Date(b?.created_at || 0))
}

// QCL-BACKEND-UX #130: derives a visitor's identity badge from the raw
// conversation row. The conversations list route joins widget_visitors via
// correlated subqueries (`visitor_verified`, `visitor_identified_attrs_json`)
// — this mirrors the precedence rules in
// services/auth/lib/widgetVisitorMemory.js summariseVisitor(): name beats
// email, and `verified` (collector HMAC-verified the user_hash) is
// authoritative vs. a merely self-declared identify() call. Never throws on
// missing/malformed fields — an anonymous visitor always falls through to
// the neutral 'anonymous' level.
export function getVisitorIdentity(row) {
  if (!row || typeof row !== 'object') return { level: 'anonymous', label: 'anonymous', displayName: null }
  let attrs = {}
  if (row.visitor_identified_attrs_json) {
    try {
      const parsed = JSON.parse(row.visitor_identified_attrs_json)
      if (parsed && typeof parsed === 'object') attrs = parsed
    } catch (_) { /* malformed JSON — treat as no attrs */ }
  } else if (row.visitor_identified_attrs && typeof row.visitor_identified_attrs === 'object') {
    attrs = row.visitor_identified_attrs
  }
  const name = attrs.name || [attrs.first_name, attrs.last_name].filter(Boolean).join(' ') || null
  const displayName = name || attrs.email || null
  if (!displayName) return { level: 'anonymous', label: 'anonymous', displayName: null }
  return row.visitor_verified
    ? { level: 'verified', label: 'verified', displayName }
    : { level: 'identified', label: 'signed in', displayName }
}

const IDENTITY_BADGE_STYLE = {
  verified: { color: '#30ff90', background: 'rgba(48,255,144,0.1)' },
  identified: { color: '#fbbf24', background: 'rgba(251,191,36,0.1)' },
  anonymous: { color: 'rgba(255,255,255,0.45)', background: 'rgba(255,255,255,0.06)' },
}

function IdentityBadge({ row }) {
  const identity = getVisitorIdentity(row)
  const style = IDENTITY_BADGE_STYLE[identity.level]
  return (
    <span
      title={identity.displayName || undefined}
      style={{
        fontSize: 9, padding: '1px 6px', borderRadius: 3, fontWeight: 600,
        background: style.background, color: style.color,
        flexShrink: 0, whiteSpace: 'nowrap',
      }}
    >
      {identity.label}
    </span>
  )
}

// QCL-LEARN P1: `correctedBy` is passed down from QuoxChatWidgetRoom (the
// authenticated admin's email via useAuth()) rather than called here, so
// LogsTab keeps working when rendered outside an AuthProvider (render
// tests, any future standalone route).
export default function LogsTab({ widget, authFetch, orgId, correctedBy }) {
  const navigate = useNavigate()
  const [conversations, setConversations] = useState([])
  const [totalConversations, setTotalConversations] = useState(null)
  const [selectedConv, setSelectedConv] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const [msgLoading, setMsgLoading] = useState(false)
  const [error, setError] = useState(null)
  const [filters, setFilters] = useState({ status: '', rating: '', visitor_id: '', q: '', blocked: false, includeTest: false })
  // QCX-5i: when set, slide in MessageContextPanel for that message id.
  const [contextMessageId, setContextMessageId] = useState(null)
  // QCL-LEARN P1: which assistant message has the "Improve this answer"
  // editor open, its draft text, and per-message save state (saving/saved/error).
  const [correctingMessageId, setCorrectingMessageId] = useState(null)
  const [correctionDraft, setCorrectionDraft] = useState('')
  const [correctionQuestion, setCorrectionQuestion] = useState('')
  const [correctionState, setCorrectionState] = useState({}) // { [messageId]: 'saving'|'saved'|'error' }
  // QUOXCHAT-PRO Matrix-less handoff: live reply composer for handed_off
  // conversations. Works with or without a Matrix stack: the reply persists
  // via the org-authed operator-reply route and reaches the visitor through
  // the widget's GET /quoxchat/poll loop.
  const [replyDraft, setReplyDraft] = useState('')
  const [replySending, setReplySending] = useState(false)
  const [replyError, setReplyError] = useState(null)
  // W13: admin erase of a visitor's data (GDPR-style), confirm then DELETE.
  const [eraseConfirm, setEraseConfirm] = useState(false)
  const [eraseBusy, setEraseBusy] = useState(false)
  const [eraseResult, setEraseResult] = useState(null) // { ok, text }
  // P2 "Logs list upgrade": single Export button opens a small CSV/JSON menu.
  const [exportMenuOpen, setExportMenuOpen] = useState(false)

  // B5 audit fix: day divider before the first message of a new day. Messages
  // are already sorted chronologically ascending (sortMessagesByTime).
  const dayDividers = useMemo(() => {
    let lastDay = null
    return messages.map(m => {
      const day = m.created_at ? formatDayDivider(m.created_at) : null
      const isNewDay = day && day !== lastDay
      lastDay = day
      return isNewDay ? day : null
    })
  }, [messages])

  // P2 "Logs list upgrade": day divider before the first conversation row of
  // a new day. The list is already sorted most-recent-first (see the fetch
  // effect below), so a single backward scan produces the dividers.
  const conversationDayDividers = useMemo(() => {
    let lastDay = null
    return conversations.map(c => {
      const ts = c.last_message_at || c.started_at || c.created_at
      const day = ts ? formatListDayLabel(ts) : null
      const isNewDay = day && day !== lastDay
      lastDay = day
      return isNewDay ? day : null
    })
  }, [conversations])

  const queryString = useMemo(() => {
    const p = new URLSearchParams()
    if (filters.status) p.set('status', filters.status)
    if (filters.rating) p.set('rating', filters.rating)
    if (filters.visitor_id) p.set('visitor_id', filters.visitor_id.trim())
    if (filters.q) p.set('q', filters.q.trim())
    if (filters.blocked) p.set('blocked', '1')
    if (filters.includeTest) p.set('include_test', '1')
    p.set('limit', '100')
    return p.toString()
  }, [filters])

  useEffect(() => {
    if (!authFetch || !orgId || !widget?.id) return
    let cancelled = false
    setLoading(true)
    setError(null)
    authFetch(`/api/orgs/${orgId}/widgets/${widget.id}/conversations?${queryString}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => {
        if (cancelled) return
        const rows = Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
        // QUOXCHAT-PRO Matrix-less handoff: most-recent activity first, so an
        // operator's live handed-off conversation is at the top of the list
        // (server order is insurance-sorted here too; fall back to start time
        // for rows that never got a last_message_at).
        rows.sort((a, b) =>
          new Date(b?.last_message_at || b?.started_at || b?.created_at || 0)
          - new Date(a?.last_message_at || a?.started_at || a?.created_at || 0))
        setConversations(rows)
        setTotalConversations(Number.isFinite(data?.pagination?.total) ? data.pagination.total : null)
      })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [authFetch, orgId, widget?.id, queryString])

  const handleSelectConv = async (conv) => {
    setSelectedConv(conv)
    setMessages([])
    setReplyDraft('')
    setReplyError(null)
    if (!authFetch || !orgId || !widget?.id) return
    setMsgLoading(true)
    try {
      const r = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}/conversations/${conv.id}/messages`)
      if (r.ok) {
        const data = await r.json()
        setMessages(sortMessagesByTime(Array.isArray(data?.messages) ? data.messages : []))
      }
    } catch (_) { /* non-fatal */ }
    finally { setMsgLoading(false) }
  }

  // QUOXCHAT-PRO Matrix-less handoff: while a handed_off conversation is
  // open, poll its transcript every 10s so visitor replies appear without a
  // manual refresh (mirrors the widget's own 10s poll cadence).
  useEffect(() => {
    if (!authFetch || !orgId || !widget?.id) return
    if (!selectedConv?.id || selectedConv.status !== 'handed_off') return
    const convId = selectedConv.id
    let cancelled = false
    const tick = async () => {
      try {
        const r = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}/conversations/${convId}/messages`)
        if (!r.ok || cancelled) return
        const data = await r.json()
        if (!cancelled && Array.isArray(data?.messages)) setMessages(sortMessagesByTime(data.messages))
      } catch (_) { /* non-fatal, retried on the next tick */ }
    }
    const interval = setInterval(tick, 10000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [authFetch, orgId, widget?.id, selectedConv?.id, selectedConv?.status])

  // QUOXCHAT-PRO Matrix-less handoff: send an operator reply. The route
  // derives the operator identity server-side from the logged-in dashboard
  // user; optimistic append so the reply shows instantly, the 10s poll then
  // reconciles with the persisted row.
  const handleEraseVisitor = async () => {
    const visitorId = selectedConv?.visitor_id
    if (!visitorId || eraseBusy) return
    if (!authFetch || !orgId || !widget?.id) return
    setEraseBusy(true)
    setEraseResult(null)
    try {
      const r = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}/visitors/${encodeURIComponent(visitorId)}`, { method: 'DELETE' })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.message || data.error || `Erase failed (${r.status})`)
      const counts = data.counts && typeof data.counts === 'object' ? data.counts : data
      const parts = Object.entries(counts)
        .filter(([k, v]) => typeof v === 'number' && k !== 'status')
        .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`)
      setEraseResult({ ok: true, text: `Visitor data erased${parts.length ? `: ${parts.join(', ')}` : ''}.` })
      setConversations(cs => cs.filter(c => c.visitor_id !== visitorId))
      setSelectedConv(null)
      setMessages([])
    } catch (err) {
      setEraseResult({ ok: false, text: err.message })
    } finally {
      setEraseBusy(false)
      setEraseConfirm(false)
    }
  }

  const handleSendReply = async () => {
    const text = replyDraft.trim()
    if (!text || replySending || !selectedConv?.id) return
    if (!authFetch || !orgId || !widget?.id) return
    setReplySending(true)
    setReplyError(null)
    try {
      const r = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}/conversations/${selectedConv.id}/operator-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || data.success === false) throw new Error(data.error || `Reply failed (${r.status})`)
      setMessages(msgs => [...msgs, {
        id: data.message_id || `local-${Date.now()}`,
        role: 'operator',
        content: text,
        sender_name: data.sender_name || null,
        created_at: new Date().toISOString(),
        sources: [], tool_calls: [], confidence: null,
      }])
      setReplyDraft('')
    } catch (err) {
      setReplyError(err.message)
    } finally {
      setReplySending(false)
    }
  }

  // QCL-LEARN P1 — "this answer would have been better" correction loop.
  // Opens an inline editor pre-filled with the preceding user question +
  // the current assistant answer. Save re-uses the existing manual FAQ
  // ingest endpoint with provenance so the collector pins it into the
  // widget's KB as a 'correction' entry and threads it back to this turn.
  const handleOpenCorrection = (msg, index) => {
    const prevUser = [...messages.slice(0, index)].reverse().find(m => m.role === 'user')
    setCorrectingMessageId(msg.id)
    setCorrectionDraft(msg.content || '')
    setCorrectionState(s => ({ ...s, [msg.id]: undefined }))
    // Stash the question alongside the draft via a ref-free closure — kept
    // in state so Save doesn't need to re-derive it.
    setCorrectionQuestion(prevUser?.content || '')
  }

  const handleCancelCorrection = () => {
    setCorrectingMessageId(null)
    setCorrectionDraft('')
    setCorrectionQuestion('')
  }

  const handleSaveCorrection = async (msg) => {
    if (!widget?.id || !correctionDraft.trim() || !correctionQuestion.trim()) return
    // QCL-SECURITY P0-1: /knowledge/qa now requires the org-scoped,
    // authenticated route — a real widget context is required.
    if (!authFetch || !orgId) { setCorrectionState(s => ({ ...s, [msg.id]: 'error' })); return }
    setCorrectionState(s => ({ ...s, [msg.id]: 'saving' }))
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}/knowledge/qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: correctionQuestion,
          answer: correctionDraft,
          category: 'correction',
          source_conversation_id: selectedConv?.id || null,
          source_message_id: msg.id,
          // QCL-SECURITY P0-3: corrected_by is now derived server-side from
          // the authenticated session — the auth proxy ignores this field,
          // it's dropped here to avoid implying it's honoured.
        }),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok || data.success === false) {
        throw new Error(data.error || `Correction save failed (${resp.status})`)
      }
      setCorrectionState(s => ({ ...s, [msg.id]: 'saved' }))
      setCorrectingMessageId(null)
      setCorrectionDraft('')
      setCorrectionQuestion('')
    } catch (err) {
      setCorrectionState(s => ({ ...s, [msg.id]: 'error' }))
    }
  }

  const handleExport = () => {
    if (messages.length === 0) return
    const csv = exportToCSV(messages)
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `conversation-${selectedConv?.id || 'export'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleExportAllCsv = () => {
    if (!authFetch || !orgId || !widget?.id) return
    window.open(`/api/orgs/${orgId}/widgets/${widget.id}/conversations.csv?${queryString}`, '_blank')
  }

  const handleExportAllJson = () => {
    if (!authFetch || !orgId || !widget?.id) return
    window.open(`/api/orgs/${orgId}/widgets/${widget.id}/conversations.json?${queryString}`, '_blank')
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16, minHeight: 400 }}>
      {/* Left: Conversation list */}
      <div className="qx-flat-panel" style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>
            Conversations ({totalConversations ?? conversations.length})
          </span>
          {/* P2 "Logs list upgrade": one Export button opening a CSV/JSON
              menu, instead of two bare-label buttons stripped of context. */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setExportMenuOpen(o => !o)}
              title="Export the filtered conversation list"
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', fontSize: 9, fontWeight: 600, background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.15)', borderRadius: 4, cursor: 'pointer', color: '#38bdf8', fontFamily: 'inherit' }}
            >
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#38bdf8" strokeWidth="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16"/></svg>
              Export
            </button>
            {exportMenuOpen && (
              <>
                {/* Backdrop closes the menu on outside click without a
                    document-level listener. */}
                <div onClick={() => setExportMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10 }} />
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 11,
                  display: 'flex', flexDirection: 'column', minWidth: 130,
                  background: '#15151d', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6,
                  boxShadow: '0 6px 16px rgba(0,0,0,0.4)', overflow: 'hidden',
                }}>
                  <button
                    type="button"
                    onClick={() => { setExportMenuOpen(false); handleExportAllCsv() }}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 10, fontWeight: 600, background: 'transparent', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer', color: 'rgba(255,255,255,0.85)', fontFamily: 'inherit', textAlign: 'left' }}
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#38bdf8" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
                    Export CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => { setExportMenuOpen(false); handleExportAllJson() }}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 10, fontWeight: 600, background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.85)', fontFamily: 'inherit', textAlign: 'left' }}
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#a855f7" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
                    Export JSON
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        {/* P2 "Logs list upgrade": labelled filter fields, was two bare
            selects a new operator had to guess at. */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <label htmlFor="qc-logs-status-filter" style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>Status</label>
            <select id="qc-logs-status-filter" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))} style={{ padding: '3px 6px', fontSize: 10, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, color: '#fff' }}>
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="closed">Closed</option>
              <option value="handed_off">Handed off</option>
            </select>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <label htmlFor="qc-logs-rating-filter" style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>Rating</label>
            <select id="qc-logs-rating-filter" value={filters.rating} onChange={e => setFilters(f => ({ ...f, rating: e.target.value }))} style={{ padding: '3px 6px', fontSize: 10, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, color: '#fff' }}>
              <option value="">All ratings</option>
              <option value="positive">Positive</option>
              <option value="negative">Negative</option>
              <option value="unrated">Unrated</option>
            </select>
          </div>
        </div>
        {/* Wave 5: blocked injection attempts are persisted; this narrows the list to them. */}
        <label htmlFor="qc-logs-blocked-filter" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>
          <input
            id="qc-logs-blocked-filter"
            type="checkbox"
            checked={filters.blocked}
            onChange={e => setFilters(f => ({ ...f, blocked: e.target.checked }))}
          />
          Blocked turns only
        </label>
        {/* Wave 10: simulation and admin test traffic is excluded by default (counts and exports). */}
        <label htmlFor="qc-logs-include-test" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>
          <input
            id="qc-logs-include-test"
            type="checkbox"
            checked={filters.includeTest}
            onChange={e => setFilters(f => ({ ...f, includeTest: e.target.checked }))}
          />
          Include test traffic
        </label>
        {/* QCX-5k: visitor + free-text search */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
          <input
            aria-label="Search conversations"
            type="search"
            placeholder="🔍 Search messages or visitor…"
            value={filters.q}
            onChange={e => setFilters(f => ({ ...f, q: e.target.value }))}
            style={{ padding: '4px 8px', fontSize: 11, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, color: '#fff', fontFamily: 'inherit' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <label htmlFor="qc-logs-visitor-filter" style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>Visitor ID</label>
            <input
              id="qc-logs-visitor-filter"
              aria-label="Filter by visitor id"
              type="text"
              placeholder="visitor_id (exact)"
              value={filters.visitor_id}
              onChange={e => setFilters(f => ({ ...f, visitor_id: e.target.value }))}
              style={{ padding: '3px 8px', fontSize: 10, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, color: '#fff', fontFamily: "'JetBrains Mono', monospace" }}
            />
          </div>
        </div>
        {conversations.map((c, idx) => {
          const conv = formatConversation(c)
          const isSelected = selectedConv?.id === c.id
          const statusColor = conv.status === 'resolved' ? '#30ff90' : conv.status === 'abandoned' ? '#ef4444' : '#38bdf8'
          const statusBg = conv.status === 'resolved' ? 'rgba(48,255,144,0.1)' : conv.status === 'abandoned' ? 'rgba(239,68,68,0.1)' : 'rgba(56,189,248,0.1)'
          // P2 "Logs list upgrade": prefer the visitor's real name, either
          // the handoff form's visitor_name or the identify()-derived
          // lead_capture attrs (getVisitorIdentity), over the raw visitor
          // id as the row's headline.
          const identity = getVisitorIdentity(c)
          const headlineName = c.visitor_name || identity.displayName
          return (
            <div key={c.id}>
              {/* P2 "Logs list upgrade": day divider ("Today" / "Yesterday" /
                  "Mon 21 Jul") above the first row of a new day. */}
              {conversationDayDividers[idx] && (
                <div style={{
                  fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.7)',
                  textTransform: 'uppercase', letterSpacing: 0.4,
                  padding: idx === 0 ? '0 2px 4px' : '10px 2px 4px',
                }}>
                  {conversationDayDividers[idx]}
                </div>
              )}
              <button onClick={() => handleSelectConv(c)} style={{
                display: 'flex', flexDirection: 'column', gap: 3, padding: '7px 10px', textAlign: 'left',
                background: isSelected ? 'rgba(168,85,247,0.08)' : 'rgba(0,0,0,0.12)',
                border: isSelected ? '1px solid rgba(168,85,247,0.2)' : '1px solid rgba(255,255,255,0.04)',
                borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', width: '100%',
                flexShrink: 0,                  // never let the parent flex column squish a tile
                minWidth: 0,                    // allow children to truncate inside grid track
              }}>
                {/* Row 1: visitor name (QUOXCHAT-PRO handoff form / identify())
                    over the raw visitor id when known + status pill — always
                    one line, ellipsis on overflow */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, width: '100%' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, color: '#fff',
                    flex: '1 1 auto', minWidth: 0,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    fontFamily: headlineName ? 'inherit' : "'JetBrains Mono', monospace",
                  }}>{headlineName || conv.visitorId}</span>
                  {/* QCL-BACKEND-UX #130: verified / signed in / anonymous badge */}
                  <IdentityBadge row={c} />
                  <span title={conv.status} style={{
                    fontSize: 9, padding: '1px 6px', borderRadius: 3, fontWeight: 600,
                    background: statusBg, color: statusColor,
                    flexShrink: 0, whiteSpace: 'nowrap',
                  }}>{formatStatusLabel(conv.status)}</span>
                </div>
                {/* Row 1b: once a name headlines the row, keep the raw
                    visitor id visible as a small secondary code chip
                    (P2 "Logs list upgrade" item 4). */}
                {headlineName && (
                  <span style={{
                    display: 'inline-block', alignSelf: 'flex-start', maxWidth: '100%',
                    fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.7)',
                    background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 3,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    fontFamily: "'JetBrains Mono', monospace",
                  }}>{conv.visitorId}</span>
                )}
                {/* Row 1c: last-message preview (P2 "Logs list upgrade" item 3),
                    sourced from the conversations list API's
                    last_message_preview column (a 140-char slice of the most
                    recent message), no new endpoint needed. */}
                {c.last_message_preview && (
                  <div style={{
                    fontSize: 10, color: 'rgba(255,255,255,0.7)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%',
                  }}>{c.last_message_preview}</div>
                )}
                {/* Row 2: counts + date in one compact line */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 9, color: 'rgba(255,255,255,0.55)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  <span style={{ flexShrink: 0 }}>{conv.messageCount} msg</span>
                  {conv.rating && conv.rating !== '—' && <span style={{ flexShrink: 0 }}>· {conv.rating}</span>}
                  {c.has_blocked ? <span style={{ flexShrink: 0, color: '#f87171', fontWeight: 700 }}>· Blocked</span> : null}
                  {c.is_test ? <span title="Admin test or simulation traffic. Not counted in Analytics." style={{ flexShrink: 0, opacity: 0.7, fontWeight: 600 }}>· Test</span> : null}
                  <span style={{
                    marginLeft: 'auto',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{formatDayAwareTime(c.last_message_at || c.started_at || c.created_at)}</span>
                </div>
              </button>
            </div>
          )
        })}
        {loading && conversations.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: 'rgba(255,255,255,0.65)', fontSize: 12 }}>
            Loading…
          </div>
        )}
        {!loading && conversations.length === 0 && !error && (
          <div style={{ padding: 20, textAlign: 'center', color: 'rgba(255,255,255,0.65)', fontSize: 12 }}>
            {(filters.status || filters.rating || filters.visitor_id || filters.q || filters.blocked)
              ? 'No conversations match these filters. Clear them to see everything.'
              : 'No conversations yet. Transcripts appear here as soon as visitors chat with the widget on your site.'}
          </div>
        )}
        {error && (
          <div style={{ padding: 20, textAlign: 'center', color: '#ef4444', fontSize: 11 }}>
            Failed to load: {error}
          </div>
        )}
      </div>

      {/* Right: Message playback */}
      <div className="qx-flat-panel" style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        {selectedConv ? (
          <>
            <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {formatConversation(selectedConv).visitorId} · {formatConversation(selectedConv).messageCount} messages
                </span>
                {/* QCL-BACKEND-UX #130: verified / signed in / anonymous badge + identified name/email */}
                <IdentityBadge row={selectedConv} />
                {getVisitorIdentity(selectedConv).displayName && (
                  <span style={{ fontSize: 10, fontWeight: 400, color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap' }}>
                    ({getVisitorIdentity(selectedConv).displayName})
                  </span>
                )}
              </span>
              <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                {/* QUOXCHAT-PRO P2: on Matrix installs a handed-off
                    conversation gets a governed room
                    (widget_conversations.matrix_room_id, migration 085);
                    deep-link to it. Matrix-less installs never mint a room
                    id, so the button only renders when one exists; the
                    reply box below covers those deployments. */}
                {selectedConv.status === 'handed_off' && selectedConv.matrix_room_id && (
                  <button
                    onClick={() => navigate('/matrix-comms', { state: { quoxchatRoomId: selectedConv.matrix_room_id, conversationId: selectedConv.id } })}
                    title="Open the live operator room for this conversation in Matrix Rooms"
                    style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 10px', fontSize: 9, fontWeight: 600, background: 'rgba(48,255,144,0.1)', border: '1px solid rgba(48,255,144,0.25)', borderRadius: 5, cursor: 'pointer', color: '#30ff90', fontFamily: 'inherit' }}
                  >
                    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
                    View live room
                  </button>
                )}
                <button onClick={handleExport} style={{ padding: '3px 10px', fontSize: 9, fontWeight: 600, background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.15)', borderRadius: 5, cursor: 'pointer', color: '#38bdf8', fontFamily: 'inherit' }}>
                  Export CSV
                </button>
                {selectedConv.visitor_id && (
                  <button
                    type="button"
                    className="glass-btn"
                    data-testid="erase-visitor-btn"
                    onClick={() => { setEraseResult(null); setEraseConfirm(true) }}
                    title="Permanently erase this visitor's conversations, messages and profile"
                    style={{ padding: '3px 10px', fontSize: 9, fontWeight: 600, cursor: 'pointer', color: '#fca5a5', fontFamily: 'inherit' }}
                  >
                    Erase this visitor's data
                  </button>
                )}
              </span>
            </div>
            {eraseConfirm && (
              <div role="alertdialog" aria-label="Confirm erase visitor data" data-testid="erase-visitor-confirm" style={{ padding: '10px 12px', fontSize: 11, color: '#fff', background: 'rgba(239,68,68,0.14)', borderBottom: '1px solid rgba(239,68,68,0.5)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 160 }}>Permanently erase all data for visitor {selectedConv.visitor_id}? This cannot be undone.</span>
                <button type="button" className="glass-btn" data-testid="erase-visitor-confirm-yes" disabled={eraseBusy} onClick={handleEraseVisitor} style={{ padding: '4px 12px', fontSize: 11, cursor: 'pointer', color: '#fca5a5' }}>{eraseBusy ? 'Erasing…' : 'Erase'}</button>
                <button type="button" className="glass-btn" disabled={eraseBusy} onClick={() => setEraseConfirm(false)} style={{ padding: '4px 12px', fontSize: 11, cursor: 'pointer' }}>Cancel</button>
              </div>
            )}
            {eraseResult && !eraseResult.ok && (
              <div role="alert" data-testid="erase-visitor-error" style={{ padding: '8px 12px', fontSize: 11, color: '#fca5a5' }}>{eraseResult.text}</div>
            )}
            <div style={{ flex: 1, padding: 12, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {msgLoading && (
                <div style={{ padding: 12, color: 'rgba(255,255,255,0.65)', fontSize: 11 }}>Loading messages…</div>
              )}
              {messages.map((m, index) => {
                const msg = formatMessage(m)
                return (
                  <div key={m.id}>
                    {dayDividers[index] && (
                      <div style={{
                        textAlign: 'center', fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.45)',
                        textTransform: 'uppercase', letterSpacing: 0.5, margin: '10px 0 6px',
                      }}>
                        {dayDividers[index]}
                      </div>
                    )}
                    <div style={{
                      padding: '8px 12px', borderRadius: 12, maxWidth: '85%', fontSize: 12, lineHeight: 1.5,
                      alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                      // QUOXCHAT-PRO Matrix-less handoff: operator (human)
                      // replies get a green tint to stand apart from the
                      // assistant's dark bubbles.
                      background: msg.role === 'user' ? 'rgba(168,85,247,0.12)' : msg.role === 'operator' ? 'rgba(48,255,144,0.08)' : 'rgba(0,0,0,0.15)',
                      color: '#fff', marginLeft: msg.role === 'user' ? 'auto' : 0,
                    }}>
                      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.65)', marginBottom: 2 }}>
                        {msg.role}{msg.role === 'operator' && m.sender_name ? ` (${m.sender_name})` : ''} · {formatDayAwareTime(m.created_at)}
                        {m.filtered && (
                          <span style={{ marginLeft: 6, color: '#f87171', fontWeight: 700 }}>
                            · Blocked by injection guard{typeof m.injection_score === 'number' ? ` (score ${m.injection_score})` : ''}
                          </span>
                        )}
                        {/* QCX-5k: token counts (input+output) when captured */}
                        {(m.input_tokens != null || m.output_tokens != null) && (
                          <span style={{ marginLeft: 6, fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.45)' }}>
                            · {m.input_tokens ?? 0}+{m.output_tokens ?? 0} tok
                          </span>
                        )}
                      </div>
                      {msg.role === 'assistant'
                        ? <span dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                        : msg.content}
                    </div>
                    {msg.sources.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4, marginLeft: 4 }}>
                        {msg.sources.map((s, i) => {
                          const attr = formatSourceAttribution(s)
                          return (
                            <span key={i} style={{ padding: '1px 5px', borderRadius: 3, fontSize: 9, background: `${attr.badgeColor}15`, color: attr.badgeColor, fontWeight: 600 }}>
                              {attr.badge} · {attr.label} · {attr.scoreDisplay}
                            </span>
                          )
                        })}
                      </div>
                    )}
                    {msg.confidence !== null && msg.role === 'assistant' && (() => {
                      const badge = getConfidenceBadge(msg.confidence)
                      return <div style={{ fontSize: 9, color: badge.color, marginTop: 2, marginLeft: 4 }}>{badge.icon} {badge.label} ({Math.round(msg.confidence * 100)}%)</div>
                    })()}
                    {Array.isArray(m.tool_calls) && m.tool_calls.length > 0 && (
                      <div style={{ marginTop: 4, marginLeft: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {m.tool_calls.map((t, i) => (
                          <div key={i} style={{ fontSize: 9, color: t.ok ? '#a855f7' : '#ef4444', fontFamily: "'JetBrains Mono', monospace" }}>
                            ⚡ {t.name}({Object.keys(t.input || {}).join(', ')}) {t.ok ? '✓' : `✗ ${t.error || ''}`}
                          </div>
                        ))}
                      </div>
                    )}
                    {m.envelope_id && (
                      <div style={{ marginTop: 2, marginLeft: 4, fontSize: 8, color: 'rgba(255,255,255,0.35)', fontFamily: "'JetBrains Mono', monospace" }}>
                        envelope: {m.envelope_id.slice(0, 12)}…
                      </div>
                    )}
                    {/* QCX-5i: Context drill-down — only on assistant messages
                        (user rows have no captured context). */}
                    {msg.role === 'assistant' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          onClick={() => setContextMessageId(m.id)}
                          style={{
                            marginTop: 4, marginLeft: 4, padding: '2px 8px', fontSize: 9, fontWeight: 600,
                            background: 'rgba(0, 229, 255, 0.08)', border: '1px solid rgba(0, 229, 255, 0.25)',
                            borderRadius: 4, cursor: 'pointer', color: '#00e5ff', fontFamily: 'inherit',
                          }}
                          title="Show what the LLM saw (system prompt + RAG chunks + history)"
                        >
                          🧠 Context
                        </button>
                        {/* QCL-LEARN P1: "this answer would have been better" — opens
                            an inline editor pre-filled with the preceding question +
                            the current answer, and pins the correction into the KB. */}
                        <button
                          type="button"
                          onClick={() => handleOpenCorrection(m, index)}
                          style={{
                            marginTop: 4, padding: '2px 8px', fontSize: 9, fontWeight: 600,
                            background: 'rgba(48, 255, 144, 0.08)', border: '1px solid rgba(48, 255, 144, 0.25)',
                            borderRadius: 4, cursor: 'pointer', color: '#30ff90', fontFamily: 'inherit',
                          }}
                          title="Rewrite this answer and pin it to the knowledge base"
                        >
                          ✎ Improve this answer
                        </button>
                        {correctionState[m.id] === 'saved' && (
                          <span style={{ marginTop: 4, padding: '2px 8px', fontSize: 9, fontWeight: 600, color: '#30ff90' }}>
                            ✓ Correction saved
                          </span>
                        )}
                        {correctionState[m.id] === 'error' && (
                          <span style={{ marginTop: 4, padding: '2px 8px', fontSize: 9, fontWeight: 600, color: '#ef4444' }}>
                            ✗ Save failed
                          </span>
                        )}
                      </div>
                    )}
                    {/* QCL-LEARN P1: inline correction editor for this message */}
                    {msg.role === 'assistant' && correctingMessageId === m.id && (
                      <div style={{
                        marginTop: 6, marginLeft: 4, padding: 10, borderRadius: 8,
                        background: 'rgba(48, 255, 144, 0.05)', border: '1px solid rgba(48, 255, 144, 0.2)',
                        display: 'flex', flexDirection: 'column', gap: 6, maxWidth: '90%',
                      }}>
                        <label style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>
                          Question
                        </label>
                        <input
                          type="text"
                          value={correctionQuestion}
                          onChange={e => setCorrectionQuestion(e.target.value)}
                          placeholder="What was the visitor asking?"
                          style={{ padding: '4px 8px', fontSize: 11, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, color: '#fff', fontFamily: 'inherit' }}
                        />
                        <label style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>
                          Better answer
                        </label>
                        <textarea
                          value={correctionDraft}
                          onChange={e => setCorrectionDraft(e.target.value)}
                          rows={4}
                          style={{ padding: '6px 8px', fontSize: 11, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, color: '#fff', fontFamily: 'inherit', resize: 'vertical' }}
                        />
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            onClick={handleCancelCorrection}
                            style={{ padding: '3px 10px', fontSize: 9, fontWeight: 600, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, cursor: 'pointer', color: 'rgba(255,255,255,0.75)', fontFamily: 'inherit' }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSaveCorrection(m)}
                            disabled={correctionState[m.id] === 'saving'}
                            style={{ padding: '3px 10px', fontSize: 9, fontWeight: 600, background: 'rgba(48,255,144,0.12)', border: '1px solid rgba(48,255,144,0.3)', borderRadius: 4, cursor: 'pointer', color: '#30ff90', fontFamily: 'inherit' }}
                          >
                            {correctionState[m.id] === 'saving' ? 'Saving…' : 'Save correction'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {/* QUOXCHAT-PRO Matrix-less handoff: live reply composer.
                Always rendered for handed_off conversations, Matrix or not:
                the reply persists server-side and the widget's poll loop
                delivers it to the visitor. */}
            {selectedConv.status === 'handed_off' && (
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                <label style={{ fontSize: 9, fontWeight: 600, color: '#30ff90' }}>
                  Live reply (visitor sees this in the widget)
                </label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
                  <textarea
                    aria-label="Live reply to visitor"
                    value={replyDraft}
                    onChange={e => setReplyDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendReply() } }}
                    rows={2}
                    placeholder="Type a reply to the visitor… (Enter to send, Shift+Enter for a new line)"
                    style={{ flex: 1, padding: '6px 8px', fontSize: 11, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#fff', fontFamily: 'inherit', resize: 'vertical' }}
                  />
                  <button
                    type="button"
                    onClick={handleSendReply}
                    disabled={replySending || !replyDraft.trim()}
                    title="Send this reply to the visitor's chat widget"
                    style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', fontSize: 10, fontWeight: 600, background: 'rgba(48,255,144,0.12)', border: '1px solid rgba(48,255,144,0.3)', borderRadius: 6, cursor: replySending || !replyDraft.trim() ? 'default' : 'pointer', color: '#30ff90', fontFamily: 'inherit', opacity: replySending || !replyDraft.trim() ? 0.5 : 1 }}
                  >
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                    {replySending ? 'Sending…' : 'Send'}
                  </button>
                </div>
                {replyError && (
                  <span style={{ fontSize: 9, fontWeight: 600, color: '#ef4444' }}>Reply failed: {replyError}</span>
                )}
              </div>
            )}
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.65)', fontSize: 12 }}>
            {eraseResult?.ok
              ? <span role="status" data-testid="erase-visitor-success" style={{ color: '#30ff90', padding: 12, textAlign: 'center' }}>{eraseResult.text}</span>
              : 'Select a conversation on the left to replay its transcript'}
          </div>
        )}
      </div>

      {/* QCX-5i: Slide-in context drawer */}
      {contextMessageId && (
        <div
          style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(520px, 100vw)',
            zIndex: 100, padding: 16,
          }}
        >
          <MessageContextPanel
            orgId={orgId}
            widgetId={widget?.id}
            messageId={contextMessageId}
            authFetch={authFetch}
            onClose={() => setContextMessageId(null)}
          />
        </div>
      )}
    </div>
  )
}
