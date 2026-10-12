/**
 * AgentActivitySurface — VULCAN-DASH (generalised, reusable).
 *
 * The surface behind /vulcan and (Slice B) every named agent's detail page:
 * a big agent title with a condensed stats strip on the top row, a live
 * history of the agent's durable memories + session handoffs (the ONLY
 * scrolling region), and a talk-to-agent chat that carries the agent's
 * attached-CLI-session context via the S1 memory wire.
 *
 * Driven entirely by agentId. Read-only over the CLI agent: reflects + signals.
 *
 * Layout: the root carries `agent-activity-view`, which app-shell.css binds to
 * a viewport height chain (`:has()`, same pattern as InboxQ) so the History
 * list scrolls internally rather than the whole page. Stats sit inline on the
 * header row to preserve vertical space for History. Rows are clickable (with
 * a hover affordance) → a full-memory detail overlay. A LIVE toggle
 * auto-refreshes from the server (source of truth; display refresh only).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'

const REFRESH_MS = 12000
const RECENT_MS = 2 * 60 * 1000

export function relativeTime(iso) {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function TypeBadge({ type, accent }) {
  const isHandoff = type === 'fact'
  return (
    <span className="qx-pill" style={{
      fontSize: 11,
      color: isHandoff ? accent : 'rgba(255,255,255,0.8)',
      borderColor: isHandoff ? `${accent}73` : 'rgba(255,255,255,0.2)',
    }}>{type || 'memory'}</span>
  )
}

function MemoryDetailModal({ memory, onClose, accent }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (!memory) return null
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      <div
        className="qx-card"
        onClick={(e) => e.stopPropagation()}
        style={{ padding: 24, maxWidth: 720, width: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TypeBadge type={memory.memory_type} accent={accent} />
          {memory.importance && <span className="qx-pill" style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)' }}>{memory.importance}</span>}
          {memory.user_id === 'service' && <span style={{ fontSize: 12, color: accent }}>session handoff</span>}
          <div style={{ flex: 1 }} />
          <button className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
          {relativeTime(memory.created_at || memory.updated_at)}
          {(memory.created_at || memory.updated_at) ? ` · ${new Date(memory.created_at || memory.updated_at).toLocaleString()}` : ''}
        </div>
        <div style={{ overflowY: 'auto', minHeight: 0, fontSize: 14, color: '#fff', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {memory.content || '(no content)'}
        </div>
        {memory.id && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', fontFamily: 'monospace' }}>id: {memory.id}</div>}
      </div>
    </div>
  )
}

// Condensed inline stat: one prominent metric + label, header-row sized.
function InlineStat({ value, label, big, accent, live, active }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: big ? 30 : 19, fontWeight: big ? 800 : 700, color: '#fff', lineHeight: 1 }}>{value}</span>
        {big && live && (
          <span title={active ? 'Recent activity' : 'Watching for activity'} style={{
            width: 8, height: 8, borderRadius: '50%',
            background: active ? accent : 'rgba(255,255,255,0.35)',
            animation: active ? 'qxPulse 1.6s ease-out infinite' : 'none',
          }} />
        )}
      </div>
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap' }}>{label}</div>
    </div>
  )
}

function TypeBar({ byType, accent }) {
  const entries = Object.entries(byType || {})
  const total = entries.reduce((s, [, n]) => s + n, 0)
  if (!total) return null
  const palette = [accent, '#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#94a3b8']
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 120, maxWidth: 200 }}>
      <div style={{ display: 'flex', height: 7, borderRadius: 999, overflow: 'hidden', background: 'rgba(255,255,255,0.08)' }}>
        {entries.map(([t, n], i) => (
          <div key={t} title={`${t}: ${n}`} style={{ width: `${(n / total) * 100}%`, background: palette[i % palette.length] }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {entries.slice(0, 4).map(([t, n], i) => (
          <span key={t} style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.65)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: palette[i % palette.length] }} />
            {t} {n}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function AgentActivitySurface({
  agentId,
  agentName,
  agentColor = '#a855f7',
  agentRole = 'Agent',
  suggestions = [],
  subtitle,
  showChat = true,
  emptyHint,
  // GITQ Stream A: optional extra tabs in the LEFT panel alongside the built-in
  // "Activity" history. Each: { id, label, render: () => ReactNode }. When empty
  // (the default, used by /agents/:id for every agent), no tab bar renders and
  // the surface is exactly the history + chat it always was (backward compatible).
  tabs = [],
  // Which tab is active on first render ('activity' = the built-in history).
  defaultTab = 'activity',
  // Forwarded to the persistent chat sidebar so a tab (e.g. the Issues tab) can
  // inject a turn via chatHandleRef.current.send(text) — this is Send-to-Vulcan.
  chatHandleRef,
}) {
  let authFetch = null
  try { const auth = useAuth(); authFetch = auth.authFetch } catch { /* outside provider */ }

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [live, setLive] = useState(true)
  const [flash, setFlash] = useState(false)
  const [selectedMemory, setSelectedMemory] = useState(null)
  // Below 900px a 340px side column cannot fit: start collapsed (48px strip) and, if opened, stack under the history.
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 899px)').matches : false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(narrow)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const mq = window.matchMedia('(max-width: 899px)')
    const on = (e) => { setNarrow(e.matches); if (e.matches) setSidebarCollapsed(true) }
    mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on)
    return () => { mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on) }
  }, [])
  const [activeTab, setActiveTab] = useState(defaultTab)
  const extraTabs = Array.isArray(tabs) ? tabs : []
  const hasTabs = extraTabs.length > 0
  const activeExtra = hasTabs ? extraTabs.find(t => t.id === activeTab) : null
  const prevTotalRef = useRef(null)
  const inFlightRef = useRef(false)

  const load = useCallback(async (isPoll) => {
    // Never let a slow/overloaded backend freeze the surface: skip overlapping
    // polls and hard-abort any fetch after a client-side deadline. On a poll
    // failure keep the last data (don't blank the page); only a manual/initial
    // load surfaces the error.
    if (isPoll && inFlightRef.current) return
    inFlightRef.current = true
    if (!isPoll) setLoading(true)
    const ctrl = new AbortController()
    const deadline = setTimeout(() => ctrl.abort(), 8000)
    try {
      const doFetch = authFetch || fetch
      const resp = await doFetch(`/collector/api/v1/agents/${encodeURIComponent(agentId)}/activity?limit=100`, { signal: ctrl.signal })
      if (!resp.ok) throw new Error(`activity read failed (${resp.status})`)
      const body = await resp.json()
      const total = body?.stats?.total ?? 0
      if (isPoll && prevTotalRef.current != null && total > prevTotalRef.current) {
        setFlash(true); setTimeout(() => setFlash(false), 1200)
      }
      prevTotalRef.current = total
      setData(body)
      setError(body && body.ok === false && body.error ? `memory read degraded: ${body.error}` : null)
    } catch (e) {
      if (!isPoll) {
        setError(e.name === 'AbortError' ? 'activity read timed out — the collector may be busy' : e.message)
        // keep any previously loaded data rather than blanking the history
      }
    } finally {
      clearTimeout(deadline)
      inFlightRef.current = false
      if (!isPoll) setLoading(false)
    }
  }, [authFetch, agentId])

  useEffect(() => { prevTotalRef.current = null; load(false) }, [agentId, load])

  useEffect(() => {
    if (!live) return
    const t = setInterval(() => load(true), REFRESH_MS)
    return () => clearInterval(t)
  }, [live, load])

  const stats = data?.stats || {}
  const memories = data?.memories || []
  // Owner 2026-10-08: memory rows only land on detach; lastSeenAt also counts the agent's witnessed envelopes.
  const lastSeen = stats.lastSeenAt || stats.latestActivityAt
  const lastActiveMs = lastSeen ? Date.now() - new Date(lastSeen).getTime() : Infinity
  const active = lastActiveMs < RECENT_MS

  return (
    <div className="qx-view agent-activity-view" style={{ transition: 'box-shadow 0.4s', boxShadow: flash ? `inset 0 0 0 1px ${agentColor}66` : 'none' }}>
      <style>{`
        @keyframes qxPulse{0%{box-shadow:0 0 0 0 ${agentColor}80}70%{box-shadow:0 0 0 6px ${agentColor}00}100%{box-shadow:0 0 0 0 ${agentColor}00}}
        .aa-row{transition:background .12s ease,border-color .12s ease,transform .12s ease}
        .aa-row:hover{background:rgba(255,255,255,0.07)!important;border-color:${agentColor}66!important;transform:translateX(2px)}
        .aa-row:focus-visible{outline:2px solid ${agentColor}88;outline-offset:1px}
      `}</style>

      {/* Top row: big title + condensed stats + controls */}
      <div className="qx-card" style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap', flexShrink: 0 }}>
        {/* Title */}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '0.03em', color: '#fff', lineHeight: 1, textTransform: 'uppercase' }}>{agentName}</div>
          {subtitle && <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.6)', marginTop: 5 }}>{subtitle}</div>}
        </div>

        {/* Condensed stats strip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
          <InlineStat big value={loading ? '…' : (stats.total ?? 0)} label="Durable memories" accent={agentColor} live={live} active={active} />
          <InlineStat value={loading ? '…' : (stats.handoffCount ?? 0)} label="Handoffs" />
          <InlineStat value={loading ? '…' : relativeTime(lastSeen)} label="Last active" />
          <TypeBar byType={stats.byType} accent={agentColor} />
        </div>

        <div style={{ flex: 1, minWidth: 12 }} />

        {/* Controls */}
        <button
          className="qx-btn qx-btn--sm"
          onClick={() => setLive(l => !l)}
          style={live ? { borderColor: `${agentColor}66`, color: agentColor } : undefined}
          title={live ? 'Live: auto-refreshing' : 'Paused'}
        >
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6, verticalAlign: 'middle', background: live ? agentColor : 'rgba(255,255,255,0.4)' }} />
          {live ? 'Live' : 'Paused'}
        </button>
        <button className="qx-btn qx-btn--sm" onClick={() => load(false)} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Body: History (the only scroll) + fixed talk-to-agent sidebar */}
      <div style={{
        flex: 1, minHeight: 0, marginTop: 16,
        display: 'grid',
        gridTemplateColumns: showChat ? (sidebarCollapsed ? 'minmax(0, 1fr) 48px' : (narrow ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) 340px')) : 'minmax(0, 1fr)',
        gridTemplateRows: showChat && narrow && !sidebarCollapsed ? 'minmax(0, 2fr) minmax(0, 3fr)' : undefined,
        gap: 16,
      }}>
        {/* Left card fills the column; only its active-tab body scrolls */}
        <div className="qx-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          {hasTabs && (
            <div className="qx-tabs qx-tabs--underline" role="tablist" style={{ flexShrink: 0, display: 'flex', gap: 4 }}>
              <button
                role="tab"
                aria-selected={activeTab === 'activity'}
                className="qx-tab"
                onClick={() => setActiveTab('activity')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 12px', fontSize: 13, fontWeight: 600, color: activeTab === 'activity' ? '#fff' : 'rgba(255,255,255,0.55)', borderBottom: `2px solid ${activeTab === 'activity' ? agentColor : 'transparent'}` }}
              >
                Activity
              </button>
              {extraTabs.map(t => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={activeTab === t.id}
                  className="qx-tab"
                  onClick={() => setActiveTab(t.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 12px', fontSize: 13, fontWeight: 600, color: activeTab === t.id ? '#fff' : 'rgba(255,255,255,0.55)', borderBottom: `2px solid ${activeTab === t.id ? agentColor : 'transparent'}` }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {activeTab === 'activity' ? (
          <>
          {error && <div className="qx-banner qx-banner--warn" role="alert" style={{ flexShrink: 0 }}>{error}</div>}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>History</span>
            {memories.length > 0 && <span className="qx-pill" style={{ fontSize: 11 }}>{memories.length}</span>}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>click a row for detail</span>
          </div>

          {loading && <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>Loading activity…</div>}

          {!loading && memories.length === 0 && (
            <div className="qx-empty" style={{ padding: '24px 12px', textAlign: 'center', color: 'rgba(255,255,255,0.7)' }}>
              {emptyHint || <>No activity yet. Attach a CLI session as <code>{agentId}</code> and leave a handoff on detach — it appears here and in the chat context.</>}
            </div>
          )}

          {!loading && memories.length > 0 && (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {memories.map((m, i) => (
                <div
                  key={m.id || i}
                  className="aa-row"
                  onClick={() => setSelectedMemory(m)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setSelectedMemory(m)}
                  style={{
                    display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer',
                    padding: '9px 11px', borderRadius: 10,
                    border: '1px solid rgba(255,255,255,0.07)',
                    background: 'rgba(255,255,255,0.02)',
                  }}
                >
                  <div style={{ flexShrink: 0, marginTop: 2 }}><TypeBadge type={m.memory_type} accent={agentColor} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: '#fff', lineHeight: 1.5, wordBreak: 'break-word', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {String(m.content || '')}
                    </div>
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 4 }}>
                      {relativeTime(m.created_at || m.updated_at)}
                      {m.user_id === 'service' ? ' · session handoff' : ''}
                      {m.importance ? ` · ${m.importance}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          </>
          ) : (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {activeExtra && typeof activeExtra.render === 'function' ? activeExtra.render() : null}
            </div>
          )}
        </div>

        {showChat && (
          <AgentChatSidebar
            agentId={agentId}
            agentName={agentName}
            agentColor={agentColor}
            agentRole={agentRole}
            suggestions={suggestions}
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed(c => !c)}
            sessionPrefix={`AGENT_${String(agentId).toUpperCase()}`}
            emptyText={`Talk to ${agentName}: it carries the context of its attached CLI sessions.`}
            chatHandleRef={chatHandleRef}
          />
        )}
      </div>

      <MemoryDetailModal memory={selectedMemory} onClose={() => setSelectedMemory(null)} accent={agentColor} />
    </div>
  )
}
