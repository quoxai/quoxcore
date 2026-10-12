/**
 * QuoxperticusResidentView: QP-DASH P2+P3 (DEVSUITE-DEVMODE phases 17-19+).
 *
 * Per-host drill-in for a "resident" (the headless supervisor answering a
 * chat slot on a dev server, quox#453 phase 15). Route: /quoxperticus/:hostId,
 * reached from the Resident button on a dev-suite host card. Makes an
 * otherwise invisible resident visible: is it alive, who holds its slot,
 * what has it said, what has it spent, who flipped its switch.
 *
 * Layout (round 3, owner critical pass): toolbar + main + collapsible right
 * rail, the same shape every other plugin page uses to talk to its agent
 * (DockerView.jsx's dv-layout is the exemplar). The rail carries the slot
 * chat. It is a BESPOKE rail, not <AgentChatSidebar>: that component's
 * ChatEngine unconditionally drives /collector/chat against an
 * entityRegistry-resolved LLM persona (src/components/chat/ChatEngine.jsx),
 * with no seam for a different transport. This resident's channel is the
 * dev-slots say/wait/messages relay (a Matrix-backed room, not an LLM turn).
 * FINDING carried forward: AgentChatSidebar has no non-agent transport seam;
 * any future "chat with a non-LLM channel" surface hits the same wall.
 *
 * Main-column panels, same data sources DevServersHubPanel and
 * SlotsDeckPanel already poll:
 *   1. Presence (toolbar + header card): GET /api/v1/dev-servers (find the
 *      host row), GET /api/v1/dev-servers/:hostId/supervisor,
 *      GET /api/v1/slots. Dot has 4 states (round 3): grey disabled, red
 *      "not responding" (enabled, has a slot, heartbeat >15m stale), green
 *      "alive" (fresh heartbeat + recent messages), amber "quiet" otherwise.
 *   2. Governance switch: PUT /api/v1/dev-servers/:hostId/supervisor.
 *      Server-gated to human admins only (requireHumanAdmin in server.js);
 *      a 403 here is the invariant working, not a bug, so it renders as an
 *      explanation, not an error banner.
 *   3. Witnessed switch history: GET /collector/aee/query, corr-scoped to
 *      hostId. The who-flipped-my-switch audit trail.
 *   4. Turns and spend: GET /api/v1/dev-servers/:hostId/supervisor/turns.
 *
 * Rail: Chat, GET/POST /api/v1/slots/:name/messages + /say, long-polled via
 * GET /api/v1/slots/:name/wait (25s budget per call, looped).
 *
 * Licence gating follows QuoxLensView's isPluginLicensed('quoxlens') pattern
 * (../../components/quoxlens/QuoxLensView.jsx), scoped to the 'dev-servers'
 * plugin this resident belongs to: no new plugin manifest.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { useAuth } from '../../contexts/AuthContext.jsx'
// Reactive gate: re-checks on 'quox-entitlements-changed' so a cold deep
// link that renders before entitlements load does not stay locked.
import { usePluginLicensed } from '../../hooks/usePluginLicensed'
import './quoxperticus-view.css'

const HEARTBEAT_FRESH_MS = 2 * 60 * 1000
const HEARTBEAT_DEAD_MS = 15 * 60 * 1000

const OUTCOME_PILL = {
  replied: 'qx-pill--online',
  timeout: 'qx-pill--warn',
  error: 'qx-pill--danger',
  stale_skipped: 'qx-pill--ghost',
  rate_limited: 'qx-pill--ghost',
}

function relativeTime(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ResidentIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" aria-hidden="true">
      <rect x="4" y="3" width="16" height="12" rx="2" />
      <path d="M9 21h6M12 15v6" strokeLinecap="round" />
      <circle cx="9" cy="9" r="1" fill="#38bdf8" />
      <circle cx="15" cy="9" r="1" fill="#38bdf8" />
    </svg>
  )
}

function PowerIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 2v10" strokeLinecap="round" />
      <path d="M18.4 6.6a9 9 0 1 1-12.8 0" strokeLinecap="round" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M22 2 11 13" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronIcon({ direction = 'right' }) {
  return (
    <svg
      width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
      style={{ transform: direction === 'left' ? 'rotate(180deg)' : 'none' }} aria-hidden="true"
    >
      <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SpendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10M9.5 9.5c0-1.4 1.2-2.5 2.5-2.5s2.5.9 2.5 2c0 2.5-5 1.5-5 4 0 1.1 1.2 2 2.5 2s2.5-1.1 2.5-2.5" strokeLinecap="round" />
    </svg>
  )
}

function QuoxperticusLocked({ hostId }) {
  return (
    <div className="qx-view">
      <div className="qx-empty qx-card" data-testid="quoxperticus-locked">
        <div className="qx-empty__icon"><ResidentIcon /></div>
        <div className="qx-empty__title">Dev Servers is not licensed for this org</div>
        <div className="qx-empty__body">
          The resident on <code className="qx-code">{hostId}</code> lives behind the dev-servers plugin.
          Enable it in Plugins to see its presence, chat and spend.
        </div>
      </div>
    </div>
  )
}

export default function QuoxperticusResidentView() {
  const { hostId } = useParams()
  const { currentOrg } = useWorkspace()
  const { user } = useAuth()
  const role = currentOrg?.membership?.role
  const isAdmin = role === 'admin' || role === 'owner'
  const licensed = usePluginLicensed('dev-servers')

  const [devServer, setDevServer] = useState(null)
  const [devServerLoadedOnce, setDevServerLoadedOnce] = useState(false)
  const [supervisor, setSupervisor] = useState(null)
  const [slots, setSlots] = useState([])
  const [toggling, setToggling] = useState(false)
  const [governanceNote, setGovernanceNote] = useState(null)

  const [messages, setMessages] = useState(null)
  const [messagesError, setMessagesError] = useState(null)
  const [composerText, setComposerText] = useState('')
  const [sending, setSending] = useState(false)
  const cursorRef = useRef(null)
  // Owner round 3: chat moves into a collapsible right rail (the house
  // pattern every other plugin page uses to talk to its agent), not a body
  // panel. See the file-header note on why this is a bespoke rail rather
  // than AgentChatSidebar itself.
  const [chatCollapsed, setChatCollapsed] = useState(false)

  const [turns, setTurns] = useState(null)
  const [turnsSummary, setTurnsSummary] = useState(null)
  const [turnsError, setTurnsError] = useState(null)
  const [turnsLoadedOnce, setTurnsLoadedOnce] = useState(false)

  // DEVSUITE-DEVMODE phase 19: the who-flipped-my-switch audit trail. Every
  // PUT to .../supervisor is witnessed with intent quox.dev.supervisor.set,
  // corr set to the host_id (server.js), so this is a direct corr-scoped
  // read, not a search.
  const [switchHistory, setSwitchHistory] = useState(null)
  const [switchHistoryError, setSwitchHistoryError] = useState(null)

  const fetchDevServer = useCallback(async () => {
    try {
      const res = await fetch('/collector/api/v1/dev-servers')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const list = Array.isArray(data.servers) ? data.servers : []
      setDevServer(list.find((s) => s.host_id === hostId) || null)
    } catch {
      // Best-effort: the header falls back to hostId-only identity.
    } finally {
      setDevServerLoadedOnce(true)
    }
  }, [hostId])

  const fetchSupervisor = useCallback(async () => {
    try {
      const res = await fetch(`/collector/api/v1/dev-servers/${encodeURIComponent(hostId)}/supervisor`)
      if (!res.ok) return
      const data = await res.json()
      setSupervisor(data)
    } catch {
      // Best-effort: the switch stays at its last known state.
    }
  }, [hostId])

  const fetchSlots = useCallback(async () => {
    try {
      const res = await fetch('/collector/api/v1/slots')
      if (!res.ok) return
      const data = await res.json()
      setSlots(Array.isArray(data.slots) ? data.slots : [])
    } catch {
      // Best-effort: heartbeat/holder just stay unknown.
    }
  }, [])

  const fetchTurns = useCallback(async () => {
    try {
      const res = await fetch(`/collector/api/v1/dev-servers/${encodeURIComponent(hostId)}/supervisor/turns?limit=50`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setTurns(Array.isArray(data.turns) ? data.turns : [])
      setTurnsSummary(data.summary || null)
      setTurnsError(null)
    } catch (err) {
      setTurnsError(err.message)
    } finally {
      setTurnsLoadedOnce(true)
    }
  }, [hostId])

  const fetchSwitchHistory = useCallback(async () => {
    try {
      const res = await fetch(`/collector/aee/query?intent=quox.dev.supervisor.set&corr=${encodeURIComponent(hostId)}&limit=10`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setSwitchHistory(Array.isArray(data.envelopes) ? data.envelopes : [])
      setSwitchHistoryError(null)
    } catch (err) {
      setSwitchHistoryError(err.message)
    }
  }, [hostId])

  useEffect(() => {
    fetchDevServer()
    fetchSupervisor()
    fetchSlots()
    fetchSwitchHistory()
    const interval = setInterval(() => {
      fetchDevServer()
      fetchSupervisor()
      fetchSlots()
      fetchSwitchHistory()
    }, 10000)
    return () => clearInterval(interval)
  }, [fetchDevServer, fetchSupervisor, fetchSlots, fetchSwitchHistory])

  useEffect(() => {
    fetchTurns()
    const interval = setInterval(fetchTurns, 15000)
    return () => clearInterval(interval)
  }, [fetchTurns])

  const slotName = supervisor?.slot || null
  const slot = useMemo(
    () => (slotName ? slots.find((s) => s.name === slotName) || null : null),
    [slots, slotName],
  )

  const heartbeatAgeMs = slot?.last_heartbeat_at
    ? Date.now() - new Date(slot.last_heartbeat_at).getTime()
    : null
  const isFreshHeartbeat = heartbeatAgeMs != null && heartbeatAgeMs < HEARTBEAT_FRESH_MS
  const isDeadHeartbeat = heartbeatAgeMs != null && heartbeatAgeMs > HEARTBEAT_DEAD_MS

  // Owner round 3: "quiet" used to cover both "nothing to say" and "the
  // supervisor stopped polling", and the second one hid a 3-hour outage
  // behind an amber dot indistinguishable from normal idle. Split them:
  //   red    enabled, has a slot, heartbeat is >15m stale: not responding.
  //   green  enabled, heartbeat fresh, and it has said something recently.
  //   amber  enabled, heartbeat fresh, but nothing said recently: quiet.
  //   amber  (fallback) enabled but the heartbeat is in the 2-15m band, or
  //          there is no slot data to judge yet: not confidently either
  //          extreme, so read as quiet rather than invent a fifth colour.
  //   grey   disabled.
  const lastMessageAt = messages && messages.length ? messages[messages.length - 1]?.created_at : null
  const hasRecentMessages = lastMessageAt
    ? (Date.now() - new Date(lastMessageAt).getTime()) < HEARTBEAT_FRESH_MS
    : false

  const presence = (() => {
    if (!supervisor || !supervisor.enabled) return { dot: 'qx-dot--idle', label: 'disabled' }
    if (slot && isDeadHeartbeat) return { dot: 'qx-dot--offline', label: 'not responding' }
    if (isFreshHeartbeat && hasRecentMessages) return { dot: 'qx-dot--online', label: 'alive' }
    return { dot: 'qx-dot--degraded', label: 'quiet' }
  })()

  // Flips `enabled`, resending the current slot/config alongside it: same
  // full-replace posture as DevServersHubPanel's toggle, so a click here
  // never clobbers poll_seconds/turn_timeout_seconds back to default.
  const handleToggle = useCallback(async () => {
    setToggling(true)
    setGovernanceNote(null)
    try {
      const res = await fetch(`/collector/api/v1/dev-servers/${encodeURIComponent(hostId)}/supervisor`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: !(supervisor && supervisor.enabled),
          slot: supervisor?.slot ?? undefined,
          poll_seconds: supervisor?.poll_seconds,
          turn_timeout_seconds: supervisor?.turn_timeout_seconds,
          max_turns_per_hour: supervisor?.max_turns_per_hour,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setSupervisor(data)
        setGovernanceNote({ kind: 'ok', text: data.enabled ? 'Supervisor enabled.' : 'Supervisor disabled.' })
        // The flip was just witnessed server-side; refresh the trail so it
        // shows up without waiting for the next 10s poll.
        fetchSwitchHistory()
      } else if (res.status === 401 || res.status === 403) {
        setGovernanceNote({
          kind: 'governance',
          text: 'Turning autonomy on is a human decision. The resident cannot flip its own switch, and this action needs a human admin or owner session.',
        })
        fetchSupervisor()
      } else {
        setGovernanceNote({ kind: 'error', text: `Request failed (HTTP ${res.status}).` })
        fetchSupervisor()
      }
    } catch (err) {
      setGovernanceNote({ kind: 'error', text: err.message })
    } finally {
      setToggling(false)
    }
  }, [hostId, supervisor, fetchSupervisor, fetchSwitchHistory])

  // Chat: initial load then a long-poll loop against /wait, cleaned up on
  // unmount or whenever the resident's slot changes.
  useEffect(() => {
    if (!slotName) {
      setMessages(null)
      setMessagesError(null)
      return undefined
    }
    let cancelled = false
    let controller = null
    cursorRef.current = null

    async function loadInitial() {
      try {
        const res = await fetch(`/collector/api/v1/slots/${encodeURIComponent(slotName)}/messages?limit=50`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        const msgs = Array.isArray(data.messages) ? data.messages : []
        setMessages(msgs)
        setMessagesError(null)
        cursorRef.current = msgs.length ? msgs[msgs.length - 1].id : null
        waitLoop()
      } catch (err) {
        if (!cancelled) setMessagesError(err.message)
      }
    }

    async function waitLoop() {
      while (!cancelled) {
        try {
          controller = new AbortController()
          const params = new URLSearchParams({ timeout_ms: '25000' })
          if (cursorRef.current) params.set('since', cursorRef.current)
          const res = await fetch(
            `/collector/api/v1/slots/${encodeURIComponent(slotName)}/wait?${params.toString()}`,
            { signal: controller.signal },
          )
          if (cancelled) return
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          if (cancelled) return
          if (Array.isArray(data.messages) && data.messages.length) {
            setMessages((prev) => [...(prev || []), ...data.messages])
          }
          if (data.cursor) cursorRef.current = data.cursor
          setMessagesError(null)
        } catch (err) {
          if (cancelled || err.name === 'AbortError') return
          setMessagesError(err.message)
          await new Promise((resolve) => setTimeout(resolve, 5000))
        }
      }
    }

    loadInitial()

    return () => {
      cancelled = true
      if (controller) controller.abort()
    }
  }, [slotName])

  const composerFrom = user?.display_name || user?.email || 'owner'

  const handleSend = useCallback(async () => {
    const text = composerText.trim()
    if (!text || !slotName) return
    setSending(true)
    try {
      const res = await fetch(`/collector/api/v1/slots/${encodeURIComponent(slotName)}/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, from: composerFrom }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      if (data.message) {
        setMessages((prev) => [...(prev || []), data.message])
        cursorRef.current = data.message.id
      }
      setComposerText('')
      setMessagesError(null)
    } catch (err) {
      setMessagesError(err.message)
    } finally {
      setSending(false)
    }
  }, [composerText, slotName, composerFrom])

  if (!licensed) return <QuoxperticusLocked hostId={hostId} />

  return (
    <div className="qx-view qp-view">
      {/* TOOLBAR: back link + resident identity + the rail toggle. Kept
          outside the two-column layout so it never scrolls out of reach. */}
      <div className="qp-toolbar">
        <Link to="/dev-suite" className="qx-btn qx-btn--ghost qx-btn--sm" data-testid="quoxperticus-back">
          <BackIcon /> Dev Suite
        </Link>
        <div className="qx-row qx-row--tight qp-toolbar__title" style={{ alignItems: 'center' }}>
          <ResidentIcon />
          <h1 className="qp-title">quoxperticus on {hostId}</h1>
          <span className={`qx-dot ${presence.dot}`} data-testid="quoxperticus-presence-dot" title={presence.label} />
          <span className="qx-hint">{presence.label}</span>
        </div>
        <button
          type="button"
          className="qx-btn qx-btn--ghost qx-btn--sm qp-toolbar__chat-btn"
          onClick={() => setChatCollapsed((v) => !v)}
          data-testid="quoxperticus-chat-toggle"
          title={chatCollapsed ? 'Show chat' : 'Hide chat'}
        >
          <ChatIcon /> {chatCollapsed ? 'Chat' : 'Hide chat'}
        </button>
      </div>

      <div className="qp-layout">
        <div className="qp-main">

      {/* 1. PRESENCE HEADER (identity + dot moved to the toolbar above) */}
      <header className="qx-card qx-card--compact qp-presence" data-testid="quoxperticus-presence">
        {devServer?.profile_verified != null && (
          <span className={`qx-pill qx-pill--sm ${devServer.profile_verified ? 'qx-pill--online' : 'qx-pill--ghost'}`}>
            {devServer.profile_verified ? 'profile verified' : 'unverified'}
          </span>
        )}
        <div className="qp-presence__meta">
          <span>
            slot: {slotName ? <code className="qx-code">{slotName}</code> : <span className="qx-hint">none configured</span>}
          </span>
          {slot && (
            <span>
              holder: {slot.holder_session ? <b>{slot.holder_session}</b> : <span className="qx-hint">none</span>}
            </span>
          )}
          {slot?.last_heartbeat_at && (
            <span className="qx-hint">
              {isFreshHeartbeat ? `heartbeat ${relativeTime(slot.last_heartbeat_at)}` : `nothing heard since ${relativeTime(slot.last_heartbeat_at)}`}
            </span>
          )}
          <span>
            supervisor: <b>{supervisor?.enabled ? 'enabled' : 'disabled'}</b>
          </span>
          {devServer?.last_seen_at && (
            <span className="qx-hint">host last seen {relativeTime(devServer.last_seen_at)}</span>
          )}
          {devServerLoadedOnce && !devServer && (
            <span className="qx-hint qx-hint--warn">host not found in the dev-servers registry</span>
          )}
        </div>
      </header>

      {/* 2. GOVERNANCE SWITCH */}
      <section className="qx-card qp-governance" data-testid="quoxperticus-governance">
        <div className="qx-row qx-row--apart" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Governance</h3>
            <span className={`qx-pill qx-pill--sm ${supervisor?.enabled ? 'qx-pill--online' : 'qx-pill--ghost'}`} data-testid="quoxperticus-supervisor-pill">
              {supervisor?.enabled ? 'autonomy on' : 'autonomy off'}
            </span>
          </div>
          {isAdmin && (
            <button
              type="button"
              className={`qx-btn qx-btn--sm ${supervisor?.enabled ? 'qx-btn--danger' : 'qx-btn--primary'}`}
              disabled={toggling || !supervisor}
              onClick={handleToggle}
              data-testid="quoxperticus-supervisor-toggle"
            >
              <PowerIcon /> {toggling ? 'Working…' : supervisor?.enabled ? 'Disable' : 'Enable'}
            </button>
          )}
        </div>

        {!isAdmin && (
          <div className="qx-banner" style={{ marginTop: 12 }} data-testid="quoxperticus-governance-nonadmin">
            <span className="qx-banner__title">Human decision only.</span>
            Turning autonomy on is a human decision. The resident cannot flip its own switch, and neither can a
            non-admin session; ask an org admin or owner to change this.
          </div>
        )}

        {governanceNote && (
          <div
            className={`qx-banner ${governanceNote.kind === 'error' ? 'qx-banner--danger' : governanceNote.kind === 'ok' ? 'qx-banner--success' : ''}`}
            style={{ marginTop: 12 }}
            data-testid="quoxperticus-governance-note"
          >
            {governanceNote.kind === 'governance' && <span className="qx-banner__title">Working as intended.</span>}
            {governanceNote.text}
          </div>
        )}

        <div className="qp-settings" data-testid="quoxperticus-supervisor-settings">
          <div className="qx-stat-row"><span>poll interval</span><b>{supervisor?.poll_seconds ?? '-'}s</b></div>
          <div className="qx-stat-row"><span>turn timeout</span><b>{supervisor?.turn_timeout_seconds ?? '-'}s</b></div>
          <div className="qx-stat-row"><span>max turns / hour</span><b>{supervisor?.max_turns_per_hour ?? '-'}</b></div>
          <div className="qx-stat-row"><span>last changed</span><b>{supervisor?.updated_at ? relativeTime(supervisor.updated_at) : 'never'}</b></div>
          <div className="qx-stat-row"><span>changed by</span><b>{supervisor?.updated_by || '-'}</b></div>
        </div>
      </section>

      {/* EVIDENCE: the who-flipped-my-switch audit trail (DEVSUITE-DEVMODE
          phase 19). Every governance PUT above is witnessed with intent
          quox.dev.supervisor.set, corr = hostId, so this is a direct
          corr-scoped read of that trail, not a search. */}
      <section className="qx-card qx-card--compact qp-evidence" data-testid="quoxperticus-evidence">
        <h3 style={{ margin: '0 0 10px' }}>Witnessed switch history</h3>
        {switchHistoryError && (
          <div className="qx-hint qx-hint--danger" data-testid="quoxperticus-evidence-error">{switchHistoryError}</div>
        )}
        {!switchHistoryError && switchHistory === null && (
          <div className="qx-stack qx-stack--tight">
            <div className="qx-skeleton qx-skeleton--line-sm" />
          </div>
        )}
        {!switchHistoryError && switchHistory && switchHistory.length === 0 && (
          <div className="qx-empty" data-testid="quoxperticus-evidence-empty">
            <div className="qx-empty__title">No witnessed switch flips yet</div>
            <div className="qx-empty__body">
              Nobody has changed this resident's supervisor switch. Every enable or disable through
              the Governance panel above is witnessed and will appear here.
            </div>
          </div>
        )}
        {!switchHistoryError && switchHistory && switchHistory.length > 0 && (
          <div className="qx-log-stream" data-testid="quoxperticus-evidence-log">
            {switchHistory.map((env, i) => {
              const actor = (env.from || '').replace(/^human\./, '') || 'unknown'
              const enabled = !!env.payload?.enabled
              // Round 3: the envelope only carries a bare ULID actor id, not
              // an email. When it looks like one (26 chars, no @) and this
              // row's timestamp lands within a minute of the CURRENT
              // supervisor settings' updated_at, show updated_by beside it
              // as a labelled approximation, not a claimed identity match.
              const looksLikeUlid = actor.length === 26 && !actor.includes('@')
              const withinAMinuteOfUpdate = supervisor?.updated_at
                ? Math.abs(new Date(env.ts).getTime() - new Date(supervisor.updated_at).getTime()) <= 60000
                : false
              const approxEmail = looksLikeUlid && withinAMinuteOfUpdate ? supervisor?.updated_by : null
              return (
                <div className="qx-log-line" key={env.id || `${env.ts}-${i}`}>
                  <span className="qx-log-line__ts">{relativeTime(env.ts)}</span>
                  <span className={`qx-pill qx-pill--sm ${enabled ? 'qx-pill--online' : 'qx-pill--ghost'}`}>
                    {enabled ? 'enabled' : 'disabled'}
                  </span>
                  <span className="qx-log-line__src">
                    {actor}
                    {approxEmail && (
                      <span className="qx-hint" title="actor id from the envelope"> ({approxEmail})</span>
                    )}
                  </span>
                  <span className="qx-log-line__msg">
                    <span className="qx-trail__node qx-trail__node--aee">AEE</span>
                    {env.payload?.slot ? `slot ${env.payload.slot}` : 'no slot set'}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* 3. TURNS AND SPEND */}
      <section className="qx-card qp-turns" data-testid="quoxperticus-turns">
        <div className="qx-row qx-row--apart" style={{ flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Turns and spend</h3>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={fetchTurns} data-testid="quoxperticus-turns-refresh">
            <RefreshIcon /> Refresh
          </button>
        </div>

        {turnsSummary && (
          <div className="qx-row qx-row--tight qp-turns__summary" style={{ marginBottom: 14 }}>
            <span className="qx-pill qx-pill--sm qx-pill--info">{turnsSummary.turns} turns</span>
            <span className="qx-pill qx-pill--sm qx-pill--online">{turnsSummary.replied} replied</span>
            <span className="qx-pill qx-pill--sm qx-pill--purple qp-turns__spend">
              <SpendIcon /> ${Number(turnsSummary.total_cost_usd || 0).toFixed(4)}
            </span>
          </div>
        )}

        {turnsError && (
          <div className="qx-empty" data-testid="quoxperticus-turns-error">
            <div className="qx-empty__title">Turns fetch failed</div>
            <div className="qx-empty__body">{turnsError}</div>
          </div>
        )}

        {!turnsError && turnsLoadedOnce && (!turns || turns.length === 0) && (
          <div className="qx-empty" data-testid="quoxperticus-turns-empty">
            <div className="qx-empty__title">No turns recorded yet</div>
            <div className="qx-empty__body">Every attempted turn (replied, timed out, errored or skipped) will show up here.</div>
          </div>
        )}

        {!turnsError && turns && turns.length > 0 && (
          <table className="qx-table" data-testid="quoxperticus-turns-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Outcome</th>
                <th>From</th>
                <th className="qx-num">Chars</th>
                <th className="qx-num">Cost</th>
                <th className="qx-num">Duration</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {turns.map((t) => (
                <tr key={t.id}>
                  <td className="qx-hint">{relativeTime(t.created_at)}</td>
                  <td>
                    <span className={`qx-pill qx-pill--sm ${OUTCOME_PILL[t.outcome] || 'qx-pill--ghost'}`}>{t.outcome}</span>
                  </td>
                  <td>{t.message_from || '-'}</td>
                  <td className="qx-num qx-mono">{t.reply_chars ?? '-'}</td>
                  <td className="qx-num qx-mono">{t.cost_usd != null ? `$${Number(t.cost_usd).toFixed(4)}` : '-'}</td>
                  <td className="qx-num qx-mono">{t.duration_ms != null ? `${t.duration_ms}ms` : '-'}</td>
                  <td className="qx-hint">{t.error_note || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Limits gate: maturity stated on the surface itself, not just in a
          STATUS doc nobody reading this page will find. */}
      <div className="qx-banner qp-maturity" data-testid="quoxperticus-maturity-note">
        Beta: switch history and spend receipts began 2026-08-23; earlier activity predates the receipts and is not shown.
      </div>

        </div>

        {/* CHAT RAIL (round 3): this is now the standard toolbar + main +
            collapsible right-rail shape every other plugin page uses to talk
            to its agent (see DockerView.jsx's dv-layout/dv-sidebar for the
            exemplar). It is a bespoke rail, not <AgentChatSidebar>: that
            component's ChatEngine always drives /collector/chat against an
            entityRegistry-resolved LLM persona, with no seam for a different
            transport. The resident's channel is the dev-slots say/wait/
            messages relay (a Matrix-backed room, not an LLM turn), so reusing
            AgentChatSidebar as-is would mean either faking a persona whose
            "replies" are actually someone else's slot messages, or adding a
            pluggable-transport prop to a component 60+ surfaces already
            depend on. Both are real surgery, not a placement change: the
            finding to carry forward: AgentChatSidebar has no non-agent
            transport seam, so any future "chat with a non-LLM channel"
            surface hits this same wall. */}
        <aside
          className={`qp-rail qx-card${chatCollapsed ? ' qp-rail--collapsed' : ''}`}
          data-testid="quoxperticus-chat"
        >
          {chatCollapsed ? (
            <button
              type="button"
              className="qp-rail__collapsed-strip"
              onClick={() => setChatCollapsed(false)}
              data-testid="quoxperticus-chat-expand"
              title="Open chat"
            >
              <ChatIcon />
              <span className="qp-rail__collapsed-label">CHAT</span>
            </button>
          ) : (
            <>
              <div className="qp-rail__header">
                <ChatIcon />
                <span className="qp-rail__title">Chat</span>
                <button
                  type="button"
                  className="qx-btn qx-btn--ghost qx-btn--sm qp-rail__collapse-btn"
                  onClick={() => setChatCollapsed(true)}
                  data-testid="quoxperticus-chat-collapse"
                  title="Collapse chat"
                >
                  <ChevronIcon direction="right" />
                </button>
              </div>

              {!slotName ? (
                <div className="qx-empty" data-testid="quoxperticus-chat-empty">
                  <div className="qx-empty__title">No slot yet</div>
                  <div className="qx-empty__body">
                    This resident has no slot configured, so it has no channel to speak in. Assign one from the
                    supervisor settings, or with <code className="qx-code">quox dev supervisor set {hostId} --slot &lt;name&gt;</code>.
                  </div>
                </div>
              ) : (
                <>
                  {messagesError && (
                    <div className="qx-hint qx-hint--danger qp-rail__error" data-testid="quoxperticus-chat-error">
                      {messagesError}
                    </div>
                  )}
                  <div className="qx-log-stream qp-rail__log" data-testid="quoxperticus-chat-log">
                    {messages === null && (
                      <div className="qx-stack qx-stack--tight">
                        <div className="qx-skeleton qx-skeleton--line-sm" />
                        <div className="qx-skeleton qx-skeleton--line-sm" style={{ width: '70%' }} />
                      </div>
                    )}
                    {messages && messages.length === 0 && (
                      <div className="qx-empty" data-testid="quoxperticus-chat-nomessages">
                        <div className="qx-empty__title">Nothing said yet</div>
                        <div className="qx-empty__body">Send the first message below.</div>
                      </div>
                    )}
                    {/* Round 4 fix: the rail is ~300px wide, well under the
                        third-of-viewport threshold where .qx-log-line's
                        4-column grid squeezes text to one character per line
                        (the exact bug SlotsDeckPanel's SlotMessages hit and
                        fixed with .qx-slot-msg, see QX_INDEX). Same fix here:
                        meta line on top, full-width wrapping body below. */}
                    {messages && messages.map((m) => (
                      <div className="qx-slot-msg" key={m.id}>
                        <div className="qx-slot-msg__meta">
                          <span className="qx-log-line__src">{m.from || 'unknown'}</span>
                          <span className="qx-log-line__level qx-log-line__level--info">{m.source || 'say'}</span>
                          <span className="qx-log-line__ts">{relativeTime(m.created_at)}</span>
                        </div>
                        <div className="qx-slot-msg__body">{m.text}</div>
                      </div>
                    ))}
                  </div>
                  <div className="qx-row qx-row--tight qp-rail__composer">
                    <input
                      type="text"
                      className="qx-input qx-input--grow"
                      placeholder={`message ${slotName}`}
                      value={composerText}
                      data-testid="quoxperticus-chat-input"
                      onChange={(e) => setComposerText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && composerText.trim() && !sending) handleSend() }}
                    />
                    <button
                      type="button"
                      className="qx-btn qx-btn--sm"
                      disabled={sending || !composerText.trim()}
                      onClick={handleSend}
                      data-testid="quoxperticus-chat-send"
                    >
                      <SendIcon /> {sending ? 'Sending…' : 'Say'}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
