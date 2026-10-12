/**
 * SlotsDeckPanel — DEVSUITE-SLOTS Phase 8: the slots deck (docs/QuoxPlan
 * DEVSUITE-SLOTS plan v2 section 1d — "the deck view in /dev-suite is the
 * same registry the cockpit later renders as tiles").
 *
 * The org's slot pool (GET /collector/api/v1/slots,
 * services/collector/lib/devSlotsStore.js). Each card: slot name, state
 * pill (free/held/stale), holder session + kind, host, checkout age and
 * heartbeat freshness, a drill-in toggle that loads the slot's recent
 * message cache (GET /collector/api/v1/slots/:name/messages,
 * devSlotMessagesStore.js), and inline actions to create, checkout,
 * release, say and retire — the same verbs as `quox slot`.
 *
 * v2 (this file) makes the deck interactive: sessions never hold Matrix
 * credentials, so every write here goes through the collector's slot
 * routes exactly as the CLI does (plan section 2c is unchanged, only the
 * caller gained a browser front door). Requests use the browser cookie
 * (org pinned server-side to the caller's token) — never add org_id to a
 * body from this file.
 *
 * Fetch + expand pattern mirrors DevServersHubPanel.jsx: plain org-scoped
 * fetch, a connection-id ref to drop stale responses, one open drill-in at
 * a time. List polls every 20s; messages poll only while a card is
 * expanded, every 10s — no LLM calls, cheap server-state polling only.
 *
 * Phase 9 adds SlotBridgesPanel: the dashboard surface for the Telegram and
 * Discord rooms `quox slot say` renders into (GET/PUT
 * /api/v1/slots/bridges(/:platform), devSlotBridgesStore.js). Backend is
 * finished; this closes the no-env-only-config gap, since the config was
 * durable and CLI-settable but only ever mentioned in this panel's copy.
 */

import { useState, useEffect, useCallback, useRef, memo } from 'react'
import { Link } from 'react-router-dom'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import GovernedConfirmDialog from './GovernedConfirmDialog'

const STATE_PILL = {
  free: 'qx-pill--ghost',
  held: 'qx-pill--info',
  stale: 'qx-pill--warn',
}

const HEARTBEAT_FRESH_MS = 2 * 60 * 1000

// P11: a session name is what a session calls itself (`quox slot claim
// --session NAME`), so the two ways to lose an assignment into the void are a
// name with characters a session can never produce, and a name that is a near
// miss for a real one. This validates the first; nearestName below catches the
// second. Neither blocks the operator, both say something BEFORE the assign
// silently sits unclaimed forever.
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function validateSessionName(raw) {
  const name = (raw || '').trim()
  if (!name) return { ok: false, reason: 'Enter a session name.' }
  if (/\s/.test(name)) return { ok: false, reason: 'Session names cannot contain spaces.' }
  if (!SESSION_NAME_RE.test(name)) {
    return { ok: false, reason: 'Use letters, digits, dot, dash or underscore only.' }
  }
  return { ok: true, name }
}

// Cheap edit distance, capped: we only care whether two names are within one
// or two typos of each other, never the exact number.
function editDistance(a, b) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > 2) return 99
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
      last = tmp
    }
  }
  return prev[b.length]
}

function nearestName(candidate, known) {
  const c = candidate.toLowerCase()
  let best = null
  let bestD = 99
  for (const k of known) {
    if (!k) continue
    if (k.toLowerCase() === c) return null // exact match is not a near miss
    const d = editDistance(c, k.toLowerCase())
    if (d < bestD) { bestD = d; best = k }
  }
  return bestD <= 2 ? best : null
}

function SlotIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="4" width="7" height="16" rx="1.5" />
      <rect x="14" y="4" width="7" height="16" rx="1.5" />
      <circle cx="6.5" cy="8" r="1" fill="#38bdf8" />
    </svg>
  )
}

function ChevronIcon({ expanded }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
      style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }} aria-hidden="true">
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  )
}

function CheckoutIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="10" width="18" height="11" rx="2" />
      <path d="M7 10V7a5 5 0 0 1 10 0v3" />
    </svg>
  )
}

function ReleaseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" />
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

// Cross-link to the resident page (DEVSUITE-DEVMODE phase 19). No general
// slot-to-supervisor lookup exists on this panel yet, so this uses the
// narrower rule that IS derivable from data already fetched here: a slot
// named quoxperticus-* with a host_id on the row (set once a session checks
// it out onto a host) is a resident's own slot.
function ResidentIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="4" y="3" width="16" height="12" rx="2" />
      <path d="M9 21h6M12 15v6" strokeLinecap="round" />
      <circle cx="9" cy="9" r="1" fill="currentColor" />
      <circle cx="15" cy="9" r="1" fill="currentColor" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function BridgeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.5-1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
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

const SlotMessages = memo(function SlotMessages({ slotName, messages, loading, error }) {
  if (error) {
    return <div className="qx-hint qx-hint--danger" data-testid={`slot-messages-error-${slotName}`}>Messages unavailable: {error}</div>
  }
  if (loading && !messages) {
    return (
      <div className="qx-stack qx-stack--tight" data-testid={`slot-messages-loading-${slotName}`}>
        <div className="qx-skeleton qx-skeleton--line-sm" />
        <div className="qx-skeleton qx-skeleton--line-sm" />
        <div className="qx-skeleton qx-skeleton--line-sm" style={{ width: '70%' }} />
      </div>
    )
  }
  if (!messages || messages.length === 0) {
    return (
      <div className="qx-hint" data-testid={`slot-messages-empty-${slotName}`}>
        Nothing in this slot chat thread yet. Send one below, or with <code className="qx-code">quox slot say {slotName} "..."</code>
      </div>
    )
  }
  return (
    <div className="qx-log-stream" data-testid={`slot-messages-${slotName}`} style={{ maxHeight: 220 }}>
      {messages.map((m) => (
        // Stacked, not the 4-column qx-log-line: inside a ~1/3-width card the
        // horizontal columns squeeze the message to one char per line. Meta on
        // top, full-width wrapping text below.
        <div className="qx-slot-msg" key={m.id}>
          <div className="qx-slot-msg__meta">
            <span className="qx-log-line__src">{m.from || 'unknown'}</span>
            <span className="qx-log-line__level qx-log-line__level--info">{m.source}</span>
            <span className="qx-log-line__ts">{relativeTime(m.created_at)}</span>
          </div>
          <div className="qx-slot-msg__body">{m.text}</div>
        </div>
      ))}
    </div>
  )
})

// DEVSUITE-SLOTS Phase 9 — bridge configuration surface. GET/PUT
// /api/v1/slots/bridges(/:platform) already exist and are finished
// server-side (services/collector/server.js, devSlotBridgesStore.js); this
// only gives them a dashboard surface, closing the no-env-only-config gap
// (bridge rooms were durable and CLI-settable, but only mentioned in prose
// here). GET reads are open to any authenticated caller; the PUT write is
// requireHumanAdmin-gated, stricter than the dashboardRole `isAdmin` used to
// show/hide the controls below, so an admin held on an agent-scoped session
// or a service key can still see a 403 from a click the UI let through. That
// is expected, not broken: putBridge below turns it into a plain sentence
// naming who actually can.
//
// SECRET DISCIPLINE: a Discord bridge target is a webhook URL, and anyone
// holding it can post as that channel. GET already redacts it server-side
// (redactBridgeTarget in server.js: a Discord webhook renders as
// "discord webhook <id>", never the full URL). The PUT route's response body
// is NOT redacted the same way (it echoes the store's raw rows) — so nothing
// here reads room_id/bridges/details off a PUT response for display. Every
// render comes from the most recent GET, including right after a
// set/clear: putBridge always calls fetchBridges() rather than trusting its
// own response.

const BRIDGE_PLATFORMS = ['telegram', 'discord']

const BRIDGE_STATE_LABEL = {
  unset: 'not configured',
  unverified: 'set, unverified',
  verified: 'verified',
  failed: 'verification failed',
}

const BRIDGE_STATE_PILL = {
  unset: 'qx-pill--ghost',
  unverified: 'qx-pill--warn',
  verified: 'qx-pill--online',
  failed: 'qx-pill--danger',
}

// "set" is not "working": a room that was stored but never verified, or
// verified and then failing, must read differently from one that is live.
function bridgeVerificationState(configured, detail) {
  if (!configured) return 'unset'
  if (!detail || detail.verified_at == null) return 'unverified'
  return detail.verified_ok ? 'verified' : 'failed'
}

const BridgeRow = memo(function BridgeRow({ platform, room, detail, isAdmin, onSet, onClear, busy, note }) {
  const configured = !!room
  const state = bridgeVerificationState(configured, detail)
  const [formOpen, setFormOpen] = useState(false)
  const [roomInput, setRoomInput] = useState('')
  const [force, setForce] = useState(false)
  const isBusy = !!busy

  return (
    <div className="qx-card qx-card--compact" data-testid={`bridge-row-${platform}`}>
      <div className="qx-row qx-row--apart">
        <code style={{ fontSize: '0.85rem', fontWeight: 600 }}>{platform}</code>
        <span className={`qx-pill qx-pill--sm ${BRIDGE_STATE_PILL[state]}`} data-testid={`bridge-state-${platform}`}>
          {BRIDGE_STATE_LABEL[state]}
        </span>
      </div>

      <div className="qx-stack qx-stack--tight" style={{ marginTop: 8 }}>
        {configured ? (
          <>
            {/* `room` is already the redacted string GET returned — a
                Discord entry reads "discord webhook <id>", never the URL. */}
            <div className="qx-hint">
              {detail?.channel_label ? <><b>{detail.channel_label}</b> &middot; </> : null}
              <code className="qx-code" data-testid={`bridge-room-${platform}`}>{room}</code>
            </div>
            {state === 'verified' && (
              <div className="qx-hint qx-hint--success" data-testid={`bridge-reason-${platform}`}>
                {detail?.verified_reason || 'Verified reachable.'}
              </div>
            )}
            {state === 'unverified' && (
              <div className="qx-hint qx-hint--warn" data-testid={`bridge-reason-${platform}`}>
                Stored but never confirmed reachable. Slot messages sent here may render nowhere.
              </div>
            )}
            {state === 'failed' && (
              <div className="qx-hint qx-hint--danger" data-testid={`bridge-reason-${platform}`}>
                {detail?.verified_reason || 'Last verification failed.'}
              </div>
            )}
            {(detail?.updated_by || detail?.updated_at) && (
              <div className="qx-hint" data-testid={`bridge-updated-${platform}`}>
                set by {detail?.updated_by || 'unknown'}
                {detail?.updated_at ? ` · ${relativeTime(detail.updated_at)}` : ''}
              </div>
            )}
          </>
        ) : (
          <div className="qx-hint" data-testid={`bridge-empty-${platform}`}>
            Not configured. Setting this makes every <code className="qx-code">quox slot say</code> to
            any slot in this org also post into this {platform === 'discord' ? 'Discord channel' : 'Telegram chat'}.
            {!isAdmin && ' A human org admin sets this bridge.'}
            {' '}Terminal equivalent: <code className="qx-code">quox slot bridge set {platform} &lt;room_id&gt;</code>
          </div>
        )}
      </div>

      {isAdmin && !formOpen && (
        <div className="qx-row qx-row--tight" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <button type="button" className="qx-btn qx-btn--sm" data-testid={`bridge-set-open-${platform}`}
            disabled={isBusy} onClick={() => setFormOpen(true)}>
            <CheckoutIcon /> {configured ? 'Change' : 'Set'}
          </button>
          {configured && (
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" data-testid={`bridge-clear-${platform}`}
              disabled={isBusy} onClick={() => onClear(platform)}>
              <ReleaseIcon /> {busy === 'clear' ? 'Clearing…' : 'Clear'}
            </button>
          )}
        </div>
      )}

      {isAdmin && formOpen && (
        <div className="qx-stack qx-stack--tight" style={{ marginTop: 8 }}>
          <input
            type="text"
            className="qx-input qx-input--grow"
            placeholder={platform === 'discord' ? 'Discord webhook URL' : 'Matrix room id, e.g. !abc:quox'}
            value={roomInput}
            data-testid={`bridge-input-${platform}`}
            onChange={(e) => setRoomInput(e.target.value)}
          />
          <label className="qx-row qx-row--tight" style={{ alignItems: 'center', fontSize: '0.8rem' }}>
            <input
              type="checkbox"
              checked={force}
              data-testid={`bridge-force-${platform}`}
              onChange={(e) => setForce(e.target.checked)}
            />
            Store even if it cannot be verified (shows as unverified)
          </label>
          <div className="qx-row qx-row--tight">
            <button type="button" className="qx-btn qx-btn--sm" data-testid={`bridge-set-send-${platform}`}
              disabled={isBusy || !roomInput.trim()}
              onClick={() => {
                onSet(platform, roomInput.trim(), force)
                setFormOpen(false); setRoomInput(''); setForce(false)
              }}>
              {busy === 'set' ? 'Setting…' : 'Save'}
            </button>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" data-testid={`bridge-set-cancel-${platform}`}
              disabled={isBusy}
              onClick={() => { setFormOpen(false); setRoomInput(''); setForce(false) }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {note && (
        <div className={`qx-hint ${note.ok ? '' : 'qx-hint--danger'}`} style={{ marginTop: 6 }} data-testid={`bridge-note-${platform}`}>
          {note.text}
        </div>
      )}
    </div>
  )
})

export function SlotBridgesPanel({ isAdmin }) {
  const [bridges, setBridges] = useState({})
  const [details, setDetails] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [error, setError] = useState(null)
  const [busyByPlatform, setBusyByPlatform] = useState({})
  const [noteByPlatform, setNoteByPlatform] = useState({})
  const connectionIdRef = useRef(0)

  const fetchBridges = useCallback(async () => {
    const currentId = connectionIdRef.current
    try {
      const res = await fetch('/collector/api/v1/slots/bridges')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (connectionIdRef.current !== currentId) return
      setBridges(data.bridges || {})
      setDetails(data.details || {})
      setError(null)
      setLoadedOnce(true)
    } catch (err) {
      if (connectionIdRef.current === currentId) setError(err.message)
    } finally {
      if (connectionIdRef.current === currentId) setLoading(false)
    }
  }, [])

  useEffect(() => {
    connectionIdRef.current++
    fetchBridges()
    const interval = setInterval(fetchBridges, 30000) // catch changes made via `quox slot bridge`
    return () => {
      connectionIdRef.current++
      clearInterval(interval)
    }
  }, [fetchBridges])

  const setNote = useCallback((platform, note) => {
    setNoteByPlatform(prev => ({ ...prev, [platform]: note }))
  }, [])

  const setBusy = useCallback((platform, action) => {
    setBusyByPlatform(prev => {
      const next = { ...prev }
      if (action) next[platform] = action
      else delete next[platform]
      return next
    })
  }, [])

  const putBridge = useCallback(async (platform, body, busyKind) => {
    setNote(platform, null)
    setBusy(platform, busyKind)
    try {
      const res = await fetch(`/collector/api/v1/slots/bridges/${encodeURIComponent(platform)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 403) {
          setNote(platform, {
            ok: false,
            text: data.error || 'Setting a slot bridge requires a human org admin, not an agent session or a service key.',
          })
        } else if (res.status === 422) {
          const hint = data.detail?.hint ? ` ${data.detail.hint}` : ''
          setNote(platform, { ok: false, text: `${data.message || 'Could not verify that room.'}${hint}` })
        } else {
          setNote(platform, { ok: false, text: data.message || data.error || `HTTP ${res.status}` })
        }
        return
      }
      // Deliberately not reading room_id/bridges/details/entry off `data`
      // here — see the panel-level SECRET DISCIPLINE note above.
      const verifiedOk = data.entry ? data.entry.verified_ok : null
      setNote(platform, {
        ok: true,
        text: busyKind === 'clear'
          ? `${platform} bridge cleared.`
          : `${platform} bridge set${verifiedOk ? ' and verified.' : ', but unverified: messages may render nowhere until it is.'}`,
      })
      fetchBridges()
    } catch (err) {
      setNote(platform, { ok: false, text: err.message })
    } finally {
      setBusy(platform, null)
    }
  }, [setNote, setBusy, fetchBridges])

  const handleSet = useCallback((platform, roomId, force) => {
    putBridge(platform, { room_id: roomId, force: !!force }, 'set')
  }, [putBridge])

  const handleClear = useCallback((platform) => {
    putBridge(platform, { room_id: null }, 'clear')
  }, [putBridge])

  return (
    <div className="qx-card qx-card--compact" data-testid="slot-bridges-panel" style={{ marginBottom: 14 }}>
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center', marginBottom: 8 }}>
        <BridgeIcon />
        <h4 style={{ margin: 0 }}>Bridges</h4>
      </div>
      <div className="qx-hint" style={{ marginBottom: 10 }}>
        Where <code className="qx-code">quox slot say</code> renders into Telegram and Discord. One bridge
        room per platform, shared by every slot in this org.
      </div>
      {!isAdmin && (
        <div className="qx-hint" data-testid="slot-bridges-admin-note" style={{ marginBottom: 10 }}>
          A human org admin sets these. You can see the current state below.
        </div>
      )}

      {loading && !loadedOnce && (
        <div className="qx-stack qx-stack--tight" data-testid="slot-bridges-loading">
          <div className="qx-skeleton qx-skeleton--line-md" />
          <div className="qx-skeleton qx-skeleton--line-md" />
        </div>
      )}

      {!loading && error && (
        <div className="qx-empty" data-testid="slot-bridges-error">
          <div className="qx-empty__title">Bridge config fetch failed</div>
          <div className="qx-empty__body">{error}</div>
        </div>
      )}

      {loadedOnce && !error && (
        <div className="qx-stack qx-stack--tight">
          {BRIDGE_PLATFORMS.map(platform => (
            <BridgeRow
              key={platform}
              platform={platform}
              room={bridges[platform] || null}
              detail={details[platform] || null}
              isAdmin={isAdmin}
              onSet={handleSet}
              onClear={handleClear}
              busy={busyByPlatform[platform] || null}
              note={noteByPlatform[platform] || null}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const SlotCard = memo(function SlotCard({
  slot, expanded, onToggle, messages, messagesLoading, messagesError,
  acting, note, onAssign, onRelease, onSay, onRetire, isAdmin, knownSessions,
}) {
  const { name, state, holder_session, holder_kind, host_id, checked_out_at, last_heartbeat_at, assigned_to } = slot
  const pillClass = STATE_PILL[state] || 'qx-pill--ghost'
  const isFreshHeartbeat = last_heartbeat_at
    ? (Date.now() - new Date(last_heartbeat_at).getTime()) < HEARTBEAT_FRESH_MS
    : false
  const isStale = state === 'stale'
  // See ResidentIcon's header comment: the narrower, honestly-derivable rule.
  const residentHostId = name.startsWith('quoxperticus-') && host_id ? host_id : null

  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [checkoutName, setCheckoutName] = useState('')
  const [sayText, setSayText] = useState('')

  const busy = !!acting
  const typed = checkoutName.trim()
  const validation = typed ? validateSessionName(typed) : null
  const nearMiss = validation?.ok ? nearestName(typed, knownSessions) : null

  return (
    <div
      className={`qx-card qx-card--compact${isStale ? ' qx-card--warn' : ''}`}
      data-testid={`slot-card-${name}`}
    >
      <div className="qx-row qx-row--apart">
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <code style={{ fontSize: '0.85rem', fontWeight: 600 }}>{name}</code>
          {residentHostId && (
            <Link
              to={`/quoxperticus/${encodeURIComponent(residentHostId)}`}
              className="qx-btn qx-btn--ghost qx-btn--sm"
              data-testid={`slot-resident-link-${name}`}
              title="Open the resident page for this slot's host"
            >
              <ResidentIcon /> Resident
            </Link>
          )}
        </div>
        <span className={`qx-pill qx-pill--sm ${pillClass}`} data-testid={`slot-state-${name}`}>{state}</span>
      </div>

      <div className="qx-stack qx-stack--tight" style={{ marginTop: 10 }}>
        {holder_session ? (
          <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
            <span
              className={`qx-dot qx-dot--sm ${isFreshHeartbeat ? 'qx-dot--online' : 'qx-dot--idle'}`}
              data-testid={`slot-heartbeat-dot-${name}`}
              title={last_heartbeat_at ? `last heartbeat ${relativeTime(last_heartbeat_at)}` : 'no heartbeat yet'}
            />
            <span>{holder_session}{holder_kind ? <span className="qx-hint"> &middot; {holder_kind}</span> : null}</span>
          </div>
        ) : assigned_to ? (
          // P11: the typo trap. An assign to a name no session will ever
          // answer to sits here forever looking like normal waiting, and the
          // only way to notice was to already know the right name. So the card
          // states the exact command the named session must run: if the name
          // is wrong it is now wrong ON SCREEN, next to an Unassign button.
          <div className="qx-stack qx-stack--tight" data-testid={`slot-awaiting-${name}`}>
            <span className="qx-hint">
              waiting for <b style={{ color: 'var(--qx-accent, #38bdf8)' }}>{assigned_to}</b> to claim it
            </span>
            <code className="qx-code" style={{ overflowWrap: 'anywhere' }}>
              quox slot checkout {name} --session {assigned_to}
            </code>
            <span className="qx-hint">
              Nothing happens until that session runs it. If the name is wrong, Unassign and set it again.
            </span>
          </div>
        ) : (
          <span className="qx-hint">no holder</span>
        )}
        {host_id && <div className="qx-hint">host: {host_id}</div>}
        {checked_out_at && (
          <div className="qx-hint">
            {isStale ? `stale since checkout ${relativeTime(checked_out_at)}` : `checked out ${relativeTime(checked_out_at)}`}
          </div>
        )}
        {/* P12 honesty: "last heartbeat 4h ago" on a stale slot reads as a
            live measurement of a session that is not reporting at all. Say
            what it means instead: nothing has been heard since then. */}
        {last_heartbeat_at && (
          <div className="qx-hint">
            {isFreshHeartbeat
              ? `last heartbeat ${relativeTime(last_heartbeat_at)}`
              : `nothing heard since ${relativeTime(last_heartbeat_at)}`}
          </div>
        )}
        {!last_heartbeat_at && holder_session && (
          <div className="qx-hint">no heartbeat received yet</div>
        )}
      </div>

      {/* P12: assign/release/retire are admin-gated server-side, so rendering
          them to everyone produced a click-then-403. Non-admins now simply do
          not see them, and say/read (which they CAN do) stay available. */}
      {isAdmin && (
        <div className="qx-row qx-row--tight" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          {state === 'free' && !checkoutOpen && (
            <button type="button" className="qx-btn qx-btn--sm" data-testid={`slot-checkout-open-${name}`}
              disabled={busy} onClick={() => setCheckoutOpen(true)}>
              <CheckoutIcon /> {assigned_to ? 'Reassign' : 'Assign'}
            </button>
          )}
          {state === 'free' && assigned_to && !checkoutOpen && (
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" data-testid={`slot-unassign-${name}`}
              disabled={busy} onClick={() => onAssign(name, null)}>
              <ReleaseIcon /> {acting === 'assign' ? 'Clearing…' : 'Unassign'}
            </button>
          )}
          {(state === 'held' || state === 'stale') && (
            <button type="button" className="qx-btn qx-btn--sm qx-btn--danger" data-testid={`slot-release-${name}`}
              disabled={busy}
              onClick={() => onRelease(name, holder_session)}>
              <ReleaseIcon /> {acting === 'release' ? 'Releasing…' : 'Release'}
            </button>
          )}
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" data-testid={`slot-retire-${name}`}
            disabled={busy} onClick={() => onRetire(name)}>
            <TrashIcon /> {acting === 'retire' ? 'Retiring…' : 'Retire'}
          </button>
        </div>
      )}

      {isAdmin && checkoutOpen && (
        <div className="qx-stack qx-stack--tight" style={{ marginTop: 8 }}>
          <div className="qx-row qx-row--tight">
            <input
              type="text"
              className="qx-input qx-input--narrow"
              placeholder="session name, e.g. TRIAGE"
              value={checkoutName}
              list={`slot-sessions-${name}`}
              data-testid={`slot-checkout-input-${name}`}
              onChange={(e) => setCheckoutName(e.target.value)}
            />
            {/* Names already seen in this org, so the common case is a pick
                rather than a retype (the retype is where typos come from). */}
            <datalist id={`slot-sessions-${name}`}>
              {knownSessions.map(s => <option key={s} value={s} />)}
            </datalist>
            <button type="button" className="qx-btn qx-btn--sm" data-testid={`slot-checkout-send-${name}`}
              disabled={busy || !validation?.ok}
              onClick={() => { onAssign(name, validation.name); setCheckoutOpen(false); setCheckoutName('') }}>
              <CheckoutIcon /> {acting === 'assign' ? 'Assigning…' : 'Assign'}
            </button>
          </div>
          {validation && !validation.ok && (
            <div className="qx-hint qx-hint--danger" data-testid={`slot-checkout-invalid-${name}`}>
              {validation.reason}
            </div>
          )}
          {nearMiss && (
            <div className="qx-hint qx-hint--warn" data-testid={`slot-checkout-nearmiss-${name}`}>
              Did you mean <b>{nearMiss}</b>? Nothing claims a name that does not exist.
            </div>
          )}
        </div>
      )}

      {/* Placeholder kept SHORT deliberately: inside a card this input is
          around 200px, and the capture showed longer copy clipped mid-word. */}
      <div className="qx-row qx-row--tight" style={{ marginTop: 8 }}>
        <input
          type="text"
          className="qx-input qx-input--grow"
          placeholder="message this slot"
          value={sayText}
          data-testid={`slot-say-input-${name}`}
          onChange={(e) => setSayText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && sayText.trim() && !busy) {
              onSay(name, sayText.trim())
              setSayText('')
            }
          }}
        />
        <button type="button" className="qx-btn qx-btn--sm" data-testid={`slot-say-send-${name}`}
          disabled={busy || !sayText.trim()}
          onClick={() => { onSay(name, sayText.trim()); setSayText('') }}>
          <SendIcon /> {acting === 'say' ? 'Sending…' : 'Say'}
        </button>
      </div>

      {note && (
        <div className={`qx-hint ${note.ok ? '' : 'qx-hint--danger'}`} style={{ marginTop: 6 }} data-testid={`slot-note-${name}`}>
          {note.text}
        </div>
      )}

      <button
        type="button"
        className="qx-btn qx-btn--ghost qx-btn--sm"
        style={{ marginTop: 10 }}
        aria-expanded={expanded}
        data-testid={`slot-toggle-${name}`}
        onClick={onToggle}
      >
        <ChevronIcon expanded={expanded} /> {expanded ? 'Hide messages' : 'Show messages'}
      </button>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          <SlotMessages slotName={name} messages={messages} loading={messagesLoading} error={messagesError} />
        </div>
      )}
    </div>
  )
})

export default function SlotsDeckPanel() {
  // The org role lives on the workspace membership (currentOrg.membership
  // .role), NOT on the auth user object: `user.role` does not exist, so the
  // old `user?.role === 'admin'` check was false for EVERYONE, owner
  // included, and the deck's admin controls (create/assign/checkout/retire)
  // never rendered for anyone. Found 2026-08-20 rehearsing the owner
  // benchmark as a fresh org owner. Same pattern as ProtectedRoute.jsx.
  const { currentOrg } = useWorkspace()
  const role = currentOrg?.membership?.role
  const isAdmin = role === 'admin' || role === 'owner'
  const [slots, setSlots] = useState([])
  const [loading, setLoading] = useState(true)
  // P12: `loading` alone flips false on the first response, so a poll that
  // returned nothing briefly painted the "No slots yet" empty state over a
  // deck that had slots a second ago. Only trust emptiness after a load that
  // actually succeeded.
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [confirmAction, setConfirmAction] = useState(null)
  const [error, setError] = useState(null)
  const [expandedSlot, setExpandedSlot] = useState(null)
  const [messagesBySlot, setMessagesBySlot] = useState({})
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState(null)
  const [actingBySlot, setActingBySlot] = useState({})
  const [notesBySlot, setNotesBySlot] = useState({})
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createNote, setCreateNote] = useState(null)
  const connectionIdRef = useRef(0)

  const fetchSlots = useCallback(async () => {
    const currentId = connectionIdRef.current
    try {
      const res = await fetch('/collector/api/v1/slots')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (connectionIdRef.current !== currentId) return
      setSlots(Array.isArray(data.slots) ? data.slots : [])
      setError(null)
      setLoadedOnce(true)
    } catch (err) {
      if (connectionIdRef.current === currentId) setError(err.message)
    } finally {
      if (connectionIdRef.current === currentId) setLoading(false)
    }
  }, [])

  useEffect(() => {
    connectionIdRef.current++
    fetchSlots()
    const interval = setInterval(fetchSlots, 20000) // 20s polling
    return () => {
      connectionIdRef.current++
      clearInterval(interval)
    }
  }, [fetchSlots])

  const fetchMessages = useCallback(async (slotName) => {
    try {
      const res = await fetch(`/collector/api/v1/slots/${encodeURIComponent(slotName)}/messages?limit=50`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setMessagesBySlot(prev => ({ ...prev, [slotName]: Array.isArray(data.messages) ? data.messages : [] }))
      setMessagesError(null)
    } catch (err) {
      setMessagesError(err.message)
    } finally {
      setMessagesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!expandedSlot) return undefined
    setMessagesLoading(true)
    setMessagesError(null)
    fetchMessages(expandedSlot)
    const interval = setInterval(() => fetchMessages(expandedSlot), 10000) // 10s while expanded
    return () => clearInterval(interval)
  }, [expandedSlot, fetchMessages])

  const handleToggle = useCallback((slotName) => {
    setExpandedSlot(prev => (prev === slotName ? null : slotName))
  }, [])

  const setNote = useCallback((slotName, note) => {
    setNotesBySlot(prev => ({ ...prev, [slotName]: note }))
  }, [])

  const setActing = useCallback((slotName, action) => {
    setActingBySlot(prev => {
      const next = { ...prev }
      if (action) next[slotName] = action
      else delete next[slotName]
      return next
    })
  }, [])

  const postSlot = useCallback(async (path, body) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`)
    return data
  }, [])

  // Option B: Assign sets the EXPECTED holder (the slot stays free); the named
  // session claims it at startup with `quox slot claim`. Passing null clears it.
  const handleAssign = useCallback(async (name, session) => {
    setNote(name, null)
    setActing(name, 'assign')
    try {
      await postSlot(`/collector/api/v1/slots/${encodeURIComponent(name)}/assign`, {
        assigned_to: session || null,
      })
      setNote(name, { ok: true, text: session ? `assigned to ${session}, it claims the slot when it starts` : 'assignment cleared' })
      fetchSlots()
    } catch (err) {
      setNote(name, { ok: false, text: err.message })
    } finally {
      setActing(name, null)
    }
  }, [postSlot, setNote, setActing, fetchSlots])

  const doRelease = useCallback(async (name, holderSession) => {
    setNote(name, null)
    setActing(name, 'release')
    try {
      await postSlot(`/collector/api/v1/slots/${encodeURIComponent(name)}/release`, {
        holder_session: holderSession, force: true,
      })
      setNote(name, { ok: true, text: 'released' })
      fetchSlots()
    } catch (err) {
      setNote(name, { ok: false, text: err.message })
    } finally {
      setActing(name, null)
    }
  }, [postSlot, setNote, setActing, fetchSlots])

  const handleSay = useCallback(async (name, text) => {
    setNote(name, null)
    setActing(name, 'say')
    // P12: saying something with the log collapsed gave no sign it landed
    // beyond a "sent" note. Open the thread so the message appears where the
    // user just sent it.
    setExpandedSlot(name)
    try {
      const data = await postSlot(`/collector/api/v1/slots/${encodeURIComponent(name)}/say`, {
        text, from: 'dashboard',
      })
      if (data.message) {
        setMessagesBySlot(prev => ({ ...prev, [name]: [...(prev[name] || []), data.message] }))
      }
      setNote(name, { ok: true, text: 'sent' })
      fetchMessages(name)
    } catch (err) {
      setNote(name, { ok: false, text: err.message })
    } finally {
      setActing(name, null)
    }
  }, [postSlot, setNote, setActing, fetchMessages])

  const doRetire = useCallback(async (name) => {
    setNote(name, null)
    setActing(name, 'retire')
    try {
      await postSlot('/collector/api/v1/slots', { name, retire: true })
      if (expandedSlot === name) setExpandedSlot(null)
      fetchSlots()
    } catch (err) {
      setNote(name, { ok: false, text: err.message })
      setActing(name, null)
    }
  }, [postSlot, setNote, setActing, fetchSlots, expandedSlot])

  // The confirm dialog is the only entry to release/retire from the deck, so
  // the destructive verbs stay behind a stated consequence rather than a
  // browser popup.
  const handleRelease = useCallback((name, holderSession) => {
    setConfirmAction({
      kind: 'release',
      name,
      title: `Release ${name}?`,
      danger: true,
      body: (
        <>
          <p style={{ margin: 0 }}>
            <b>{holderSession || 'An unknown session'}</b> currently holds this slot. Releasing it
            takes the slot back so another session can claim it.
          </p>
          <p style={{ margin: 0 }} className="qx-hint">
            The holding session is not stopped, and the slot chat thread and its history are kept.
            This is witnessed as a governed action.
          </p>
        </>
      ),
      confirmLabel: 'Release slot',
      run: () => doRelease(name, holderSession),
    })
  }, [doRelease])

  const handleRetire = useCallback((name) => {
    setConfirmAction({
      kind: 'retire',
      name,
      title: `Retire ${name}?`,
      danger: true,
      body: (
        <>
          <p style={{ margin: 0 }}>
            This removes <b>{name}</b> from the pool and tears down its chat thread.
          </p>
          <p style={{ margin: 0 }} className="qx-hint">
            Anything still addressing this slot stops reaching anyone. This cannot be undone.
          </p>
        </>
      ),
      confirmLabel: 'Retire slot',
      run: () => doRetire(name),
    })
  }, [doRetire])

  const handleCreate = useCallback(async () => {
    const name = createName.trim()
    if (!name) return
    setCreateNote(null)
    setCreating(true)
    try {
      await postSlot('/collector/api/v1/slots', { name })
      setCreateNote({ ok: true, text: `${name} created` })
      setCreateName('')
      setCreateOpen(false)
      fetchSlots()
    } catch (err) {
      setCreateNote({ ok: false, text: err.message })
    } finally {
      setCreating(false)
    }
  }, [createName, postSlot, fetchSlots])

  // Session names this org has actually used, for the assign datalist and the
  // near-miss check. Derived from the deck itself rather than a new endpoint:
  // the names that matter are the ones already in play here.
  const knownSessions = Array.from(new Set(
    slots.flatMap(s => [s.holder_session, s.assigned_to]).filter(Boolean)
  )).sort()

  return (
    <div className="qx-card" data-testid="slots-deck-panel">
      {confirmAction && (
        <GovernedConfirmDialog
          testIdPrefix="slot-confirm"
          title={confirmAction.title}
          body={confirmAction.body}
          confirmLabel={confirmAction.confirmLabel}
          danger={confirmAction.danger}
          busy={!!actingBySlot[confirmAction.name]}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => { const a = confirmAction; setConfirmAction(null); a.run() }}
        />
      )}
      <div className="qx-row qx-row--apart" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <SlotIcon />
          <h3 style={{ margin: 0 }}>Slots</h3>
        </div>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <span className="qx-hint">{slots.length} slot{slots.length !== 1 ? 's' : ''}</span>
          {!isAdmin ? null : !createOpen ? (
            <button type="button" className="qx-btn qx-btn--sm" data-testid="slots-create-open" onClick={() => setCreateOpen(true)}>
              <PlusIcon /> Create slot
            </button>
          ) : (
            <>
              <input
                type="text"
                className="qx-input qx-input--narrow"
                placeholder="lowercase-name"
                value={createName}
                data-testid="slots-create-input"
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
              />
              <button type="button" className="qx-btn qx-btn--sm" data-testid="slots-create-send"
                disabled={creating || !createName.trim()} onClick={handleCreate}>
                <PlusIcon /> {creating ? 'Creating…' : 'Create'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="qx-tip" style={{ marginBottom: 12 }} data-testid="slots-help">
        <div><b>A slot is a durable, named address.</b> A session checks it out to hold it; you talk to the slot, not to whichever session holds it. Reach a slot from here, the terminal (<code className="qx-code">quox slot</code>), or a bridged Telegram or Discord channel.</div>
        <div style={{ marginTop: 6 }}>
          <b>Create</b> a slot, <b>Assign</b> it to a session name (it claims the slot at startup with <code className="qx-code">quox slot claim</code>), then <b>Say</b> to message its chat thread. Whatever holds the slot reads it, wherever it is running.
        </div>
      </div>

      {/* SLOTS-TMUX step C — benchmark item 3 ("see instructions for spawning
          a session"). Every verb here is proven end to end: the dev server
          path drives quoxagent's tmux control mode (session survives detach,
          Claude Code boots interactively in the pane with its own native
          permission UI), the terminal path is the claim flow the deck already
          teaches. Do not add a path here that has not been driven. */}
      <details className="qx-disclosure" style={{ marginBottom: 12 }} data-testid="slots-spawn-help">
        <summary className="qx-disclosure__head"><span>How to start a session</span><span className="qx-disclosure__chev">▸</span></summary>
        <div className="qx-disclosure__body">
        <div><b>Spawning a session</b>: two ways to bring one into being:</div>
        <div style={{ marginTop: 6 }}>
          <b>On a dev server</b> (no terminal of yours involved):{' '}
          <code className="qx-code">quox dev sessions new &lt;host&gt; --name &lt;slot-name&gt; --backend claude</code>{' '}
          starts a tmux-backed session on the host that survives disconnects (backends: <code className="qx-code">shell</code>, <code className="qx-code">claude</code>, <code className="qx-code">codex</code>).
          Bind it to its slot with <code className="qx-code">quox slot checkout &lt;slot-name&gt; --session &lt;session-id&gt; --host &lt;host&gt;</code>,
          then drive it with <code className="qx-code">quox dev sessions send</code> and read it with <code className="qx-code">quox dev sessions pane</code>.
          Find hosts with <code className="qx-code">quox dev doctor</code> (needs the <code className="qx-code">dev.sessions</code> capability).
        </div>
        <div style={{ marginTop: 6 }}>
          <b>In your own terminal</b>: start the session yourself (e.g. Claude Code), give it a name, and run{' '}
          <code className="qx-code">quox slot claim --session &lt;name&gt;</code>: it checks out every slot assigned to that name.
          Or take one slot directly: <code className="qx-code">quox slot checkout &lt;slot-name&gt; --session &lt;name&gt;</code>.
        </div>
        </div>
      </details>

      {createNote && (
        <div className={`qx-hint ${createNote.ok ? '' : 'qx-hint--danger'}`} style={{ marginBottom: 10 }} data-testid="slots-create-note">
          {createNote.text}
        </div>
      )}

      {loading && (
        <div className="qx-grid-auto" data-testid="slots-loading">
          {[0, 1, 2].map(i => (
            <div className="qx-card qx-card--compact" key={i}>
              <div className="qx-skeleton qx-skeleton--line-md" style={{ width: '50%' }} />
              <div className="qx-skeleton qx-skeleton--line-sm" style={{ marginTop: 10, width: '80%' }} />
              <div className="qx-skeleton qx-skeleton--line-sm" style={{ marginTop: 6, width: '60%' }} />
            </div>
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="qx-empty" data-testid="slots-error">
          <div className="qx-empty__title">Slots fetch failed</div>
          <div className="qx-empty__body">{error}</div>
        </div>
      )}

      {!loading && !error && loadedOnce && slots.length === 0 && (
        <div className="qx-empty" data-testid="slots-empty">
          <div className="qx-empty__icon">
            <SlotIcon />
          </div>
          <div className="qx-empty__title">No slots yet</div>
          <div className="qx-empty__body">
            {isAdmin ? (
              <>
                Create your first named address with <b>+ Create slot</b> above (or <code className="qx-code">quox slot create &lt;name&gt;</code>).
                Then Assign it to a session and Say to message it. A slot outlives the session that holds it, so its
                history and audience stay put.
              </>
            ) : (
              <>
                Nobody has created a slot for this org yet. Creating one needs an org admin, from this
                deck or with <code className="qx-code">quox slot create &lt;name&gt;</code>. Once a slot
                exists you can message it here without admin rights.
              </>
            )}
          </div>
        </div>
      )}

      {!loading && !error && slots.length > 0 && (
        <>
          <div className="qx-grid-auto qx-grid-auto--start" data-testid="slots-grid">
            {slots.map(slot => (
              <SlotCard
                key={slot.name}
                slot={slot}
                expanded={expandedSlot === slot.name}
                onToggle={() => handleToggle(slot.name)}
                messages={messagesBySlot[slot.name]}
                messagesLoading={expandedSlot === slot.name && messagesLoading}
                messagesError={expandedSlot === slot.name ? messagesError : null}
                acting={actingBySlot[slot.name] || null}
                note={notesBySlot[slot.name] || null}
                onAssign={handleAssign}
                onRelease={handleRelease}
                onSay={handleSay}
                onRetire={handleRetire}
                isAdmin={isAdmin}
                knownSessions={knownSessions}
              />
            ))}
          </div>
          <div className="qx-hint" style={{ marginTop: 12 }}>
            These actions match <code className="qx-code">quox slot checkout|release|say|create</code> one for one.
          </div>
        </>
      )}

      <details className="qx-disclosure" style={{ marginTop: 14 }} data-testid="slot-bridges-disclosure">
        <summary className="qx-disclosure__head"><span>Bridges (Discord, Telegram)</span><span className="qx-disclosure__chev">▸</span></summary>
        <div className="qx-disclosure__body">
          <SlotBridgesPanel isAdmin={isAdmin} />
        </div>
      </details>
    </div>
  )
}
