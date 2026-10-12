/**
 * MirrorTab - Self-Awareness Consciousness Map Display
 *
 * Read-only view of Quox's consciousness map with:
 * - Identity and health overview
 * - Cognitive implants grid with status
 * - Agents list with hierarchy
 * - Installed plugins
 * - Regenerate button for manual refresh
 */

import { useState, useEffect, useCallback } from 'react'
import { generateReflectionMap, invalidateReflectionCache } from '../../services/reflectionService'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { fetchToolTurnStats } from '../../services/toolTurnStatsClient'
import { fetchHats, fetchEffectiveHat, setUserDefaultHat } from '../../services/quoxhatClient'
import './MirrorTab.css'

// Icons
const MirrorIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M12 3v18" />
    <circle cx="8" cy="8" r="1" fill="currentColor" />
    <circle cx="16" cy="8" r="1" fill="currentColor" />
    <circle cx="8" cy="16" r="1" fill="currentColor" />
    <circle cx="16" cy="16" r="1" fill="currentColor" />
  </svg>
)

const RefreshIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M23 4v6h-6M1 20v-6h6" />
    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
  </svg>
)

const ChipIcon = ({ color }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={color || 'currentColor'} strokeWidth="1.5">
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" strokeLinecap="round" />
  </svg>
)

const AgentIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="8" r="4" />
    <path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
  </svg>
)

const PluginIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
  </svg>
)

// Format time ago
function formatTimeago(timestamp) {
  if (!timestamp) return 'Never'
  const diff = Date.now() - new Date(timestamp).getTime()
  if (diff < 60000) return 'Just now'
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
  return `${Math.round(diff / 86400000)}d ago`
}

// Health bar component
function HealthBar({ value, size = 'md' }) {
  const color = value >= 80 ? 'var(--hal-green)' :
                value >= 50 ? 'var(--hal-orange, #f59e0b)' :
                'var(--hal-red, #ef4444)'
  return (
    <div className={`mirror-health-bar mirror-health-bar--${size}`}>
      <div
        className="mirror-health-bar__fill"
        style={{ width: `${value}%`, background: color }}
      />
    </div>
  )
}

// QMH-5/1 — multi-axis status. Five honest non-healthy states + healthy +
// degraded. The legacy "DOWN" (or its visual equivalent) is now reserved
// for actual low-score backends; license, unreachable, and collecting each
// get their own label so the user knows what to do about it.
const STATUS_LABEL = {
  healthy: 'healthy',
  degraded: 'degraded',
  collecting: '◐ collecting',
  license_required: '🔒 premium',
  unreachable: '⚠ unreachable',
  down: '❌ down',
  offline: 'offline',
  locked: 'locked',
}

function StatusBadge({ status }) {
  const label = STATUS_LABEL[status] || status
  return (
    <span className={`mirror-status mirror-status--${status}`}>
      {label}
    </span>
  )
}

// Identity card
function IdentityCard({ identity, health }) {
  return (
    <div className="mirror-card mirror-card--identity">
      <div className="mirror-card__header">
        <MirrorIcon />
        <span>Identity</span>
      </div>
      <div className="mirror-identity">
        <h2 className="mirror-identity__name">{identity?.name || 'QUOX'}</h2>
        <p className="mirror-identity__role">{identity?.role || 'Multi-Agent Executive System'}</p>
        <div className="mirror-identity__version">v{identity?.version || '2.0.0'}</div>
      </div>
      <div className="mirror-health-overview">
        <div className="mirror-health-overview__value">
          <span className="mirror-health-overview__number">{health?.overall || 0}</span>
          <span className="mirror-health-overview__percent">%</span>
        </div>
        <div className="mirror-health-overview__label">
          <StatusBadge status={health?.status || 'unknown'} />
          <span>Core Health</span>
        </div>
        <HealthBar value={health?.overall || 0} size="lg" />
      </div>
    </div>
  )
}

// Memory card
function MemoryCard({ memory }) {
  if (!memory) return null
  return (
    <div className="mirror-card">
      <div className="mirror-card__header">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
        <span>Memory</span>
      </div>
      <div className="mirror-stats">
        <div className="mirror-stat">
          <span className="mirror-stat__value">{memory.totalMemories}</span>
          <span className="mirror-stat__label">Total</span>
        </div>
        <div className="mirror-stat">
          <span className="mirror-stat__value">{memory.episodic}</span>
          <span className="mirror-stat__label">Episodic</span>
        </div>
        <div className="mirror-stat">
          <span className="mirror-stat__value">{memory.semantic}</span>
          <span className="mirror-stat__label">Semantic</span>
        </div>
        <div className="mirror-stat">
          <span className="mirror-stat__value">{memory.entities}</span>
          <span className="mirror-stat__label">Entities</span>
        </div>
      </div>
      {memory.openLoops > 0 && (
        <div className="mirror-open-loops">
          <span>{memory.openLoops} open loops</span>
        </div>
      )}
    </div>
  )
}

// Capabilities card
function CapabilitiesCard({ capabilities }) {
  if (!capabilities) return null
  return (
    <div className="mirror-card">
      <div className="mirror-card__header">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
        </svg>
        <span>Capabilities</span>
      </div>
      <div className="mirror-stats mirror-stats--row">
        <div className="mirror-stat">
          <span className="mirror-stat__value">{capabilities.totalTools}</span>
          <span className="mirror-stat__label">Tools</span>
        </div>
        <div className="mirror-stat">
          <span className="mirror-stat__value">{capabilities.totalWorkflows}</span>
          <span className="mirror-stat__label">Workflows</span>
        </div>
        <div className="mirror-stat">
          <span className="mirror-stat__value">{capabilities.totalIntents}</span>
          <span className="mirror-stat__label">Intents</span>
        </div>
      </div>
    </div>
  )
}

// QUOXHAT P0 — live per-turn tool load (same org-scoped collector recorder
// the Settings execution-policy panel reads, via the shared client, so the
// Mirror and Settings can never disagree). Read-only baseline: what each
// agent actually carried into its last chat turn, and whether a provider
// cap fired (including the #653 OpenAI fallback leg).
// MIRROR-THESIS T2 — the thesis strip. The Mirror's opening statement is the
// platform's answer to the agent-scaling trilemma, told with LIVE numbers
// from the newest recorded turn (turn-stats endpoint, newest-first): aware
// of N capabilities → this turn carried n (hat, provenance, enforcement) →
// witnessed digest. Claims here are bounded by the MIRROR-THESIS proof
// ledger; the strip only ever shows what the collector actually recorded.
function ThesisStrip() {
  const { authFetch } = useAuth()
  const [latest, setLatest] = useState(null)
  const [state, setState] = useState('loading')

  useEffect(() => {
    let cancelled = false
    fetchToolTurnStats(authFetch, 50).then((r) => {
      if (cancelled) return
      if (!r.ok) { setState('error'); return }
      const entry = r.entries.find((e) => e && e.hat) || r.entries[0] || null
      if (!entry) { setState('empty'); return }
      setLatest(entry)
      setState('ok')
    })
    return () => { cancelled = true }
  }, [authFetch])

  const hat = latest?.hat || null
  return (
    <div className="mirror-thesis">
      <div className="mirror-thesis__tagline">
        Aware of everything. Carrying almost nothing. Every step witnessed.
      </div>
      {state === 'ok' && (
        <div className="mirror-thesis__live">
          <div className="mirror-thesis__seg">
            <span className="mirror-thesis__num">{latest.raw ?? '—'}</span>
            <span className="mirror-thesis__label">capabilities known · {latest.agent}</span>
          </div>
          <span className="mirror-thesis__arrow">→</span>
          <div className="mirror-thesis__seg">
            <span className="mirror-thesis__num">{latest.final ?? '—'}</span>
            <span className="mirror-thesis__label">
              carried this turn
              {hat && ` · ${hat.hat_key} hat (${hat.hat_source === 'auto_agent_match' ? 'auto-matched' : hat.hat_source}) · ${hat.enforced ? 'enforced' : 'preview'}`}
            </span>
          </div>
          {hat?.manifest_digest && (
            <>
              <span className="mirror-thesis__arrow">→</span>
              <div className="mirror-thesis__seg">
                <span className="mirror-thesis__num mirror-thesis__num--digest">{hat.manifest_digest.slice(0, 10)}…</span>
                <span className="mirror-thesis__label">manifest digest, witnessed in the WARD chain</span>
              </div>
            </>
          )}
        </div>
      )}
      {state === 'empty' && (
        <div className="mirror-thesis__live mirror-thesis__live--muted">
          No turns recorded since collector start — the next chat turn fills this in.
        </div>
      )}
      {state === 'error' && (
        <div className="mirror-thesis__live mirror-thesis__live--muted">
          Turn stats unavailable.
        </div>
      )}
    </div>
  )
}

function TurnToolLoadCard() {
  const { authFetch } = useAuth()
  const [stats, setStats] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchToolTurnStats(authFetch).then(r => { if (!cancelled) setStats(r) })
    return () => { cancelled = true }
  }, [authFetch])

  const agents = stats?.agents || {}
  const rows = Object.entries(agents)
    .sort((a, b) => (b[1].lastTs || '').localeCompare(a[1].lastTs || ''))
    .slice(0, 6)

  return (
    <div className="mirror-card">
      <div className="mirror-card__header">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2l8 4.5v9L12 20l-8-4.5v-9L12 2z" />
          <path d="M12 11v9M12 11L4 6.5M12 11l8-4.5" />
        </svg>
        <span>Tool Load per Turn</span>
        {rows.length > 0 && <span className="mirror-card__count">{rows.length}</span>}
      </div>
      {stats && !stats.ok && (
        <div className="mirror-empty">Turn stats unavailable ({stats.error})</div>
      )}
      {stats && stats.ok && rows.length === 0 && (
        <div className="mirror-empty">No turns recorded since collector start</div>
      )}
      {rows.length > 0 && (
        <div className="mirror-stats" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          {rows.map(([agent, a]) => (
            <div key={agent} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>{agent}</span>
              <span style={{ color: 'rgba(255,255,255,0.7)' }}>
                {a.lastRaw ?? '—'} → {a.lastFinal ?? '—'}
                {a.truncatedTurns > 0 && ` · ${a.truncatedTurns} capped`}
                {a.fallbackCapTurns > 0 && ` · ${a.fallbackCapTurns} fallback`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// QUOXHAT P1 — the hat catalogue on the Mirror. The Mirror is the drillable
// index of everything; QuoxHat is its management/selection layer. PREVIEW:
// selecting a hat stores the user default server-side (audited) but does not
// change executed tools until P2 enforcement. The active hat shown here is
// resolved by the SAME server precedence the collector will use.
function HatCatalogueCard() {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id
  const [hats, setHats] = useState([])
  const [active, setActive] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)

  const load = useCallback(async () => {
    if (!orgId) return
    const [list, eff] = await Promise.all([
      fetchHats(authFetch, orgId),
      fetchEffectiveHat(authFetch, orgId),
    ])
    setError(list.error || eff.error || null)
    setHats(list.hats || [])
    setActive(eff.hat ? { ...eff.hat, source: eff.source, enforcement: eff.enforcement } : null)
  }, [authFetch, orgId])

  useEffect(() => { load() }, [load])

  const select = async (hat) => {
    setBusy(hat.id)
    try {
      await setUserDefaultHat(authFetch, orgId, hat.id)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  if (!orgId) return null

  return (
    <div className="mirror-card">
      <div className="mirror-card__header">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 17c0-1.5 3.6-3 8-3s8 1.5 8 3-3.6 3-8 3-8-1.5-8-3z" />
          <path d="M8 16.2V9a4 4 0 118 0v7.2" />
        </svg>
        <span>Hats</span>
        <span className="qx-pill" style={{ marginLeft: 8 }}>preview</span>
        {hats.length > 0 && <span className="mirror-card__count">{hats.length}</span>}
      </div>
      {error && <div className="mirror-empty">Hats unavailable ({error})</div>}
      {!error && active && (
        <div style={{ marginBottom: 10, color: 'rgba(255,255,255,0.7)' }}>
          Active: <strong style={{ color: '#fff' }}>{active.name}</strong> (via {active.source?.replace('_', ' ')})
          {active.enforcement === 'preview' && ' — not yet enforced'}
        </div>
      )}
      {!error && hats.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {hats.map(hat => (
            <div key={hat.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <span>{hat.name}</span>
                {hat.definition?.transitions?.privileged && (
                  <span className="qx-pill" style={{ marginLeft: 6 }}>privileged</span>
                )}
                <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{hat.purpose}</div>
              </div>
              <button
                className="glass-btn"
                disabled={busy === hat.id || active?.id === hat.id}
                onClick={() => select(hat)}
                style={{ flexShrink: 0 }}
              >
                {active?.id === hat.id ? 'Active' : 'Wear'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Implants grid
function ImplantsGrid({ implants }) {
  if (!implants || implants.length === 0) {
    return (
      <div className="mirror-card mirror-card--wide">
        <div className="mirror-card__header">
          <ChipIcon />
          <span>Cognitive Implants</span>
        </div>
        <div className="mirror-empty">No implant data available</div>
      </div>
    )
  }

  return (
    <div className="mirror-card mirror-card--wide">
      <div className="mirror-card__header">
        <ChipIcon />
        <span>Cognitive Implants</span>
        <span className="mirror-card__count">{implants.length}</span>
      </div>
      <div className="mirror-implants">
        {implants.map(implant => (
          <div
            key={implant.id}
            className={`mirror-implant mirror-implant--${implant.status}`}
            style={{ '--implant-color': implant.color }}
          >
            <div className="mirror-implant__header">
              <span className="mirror-implant__dot" />
              <span className="mirror-implant__name">{implant.name} Implant</span>
              <StatusBadge status={implant.status} />
              {implant.tier && implant.tier !== 'free' && (
                <span style={{
                  padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 700, marginLeft: 4,
                  background: implant.tier === 'pro' ? 'rgba(245,158,11,0.15)' : 'rgba(168,85,247,0.15)',
                  color: implant.tier === 'pro' ? '#f59e0b' : '#a855f7',
                  textTransform: 'uppercase',
                }}>{implant.tier}</span>
              )}
            </div>
            {implant.inspiredBy && (
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 2, marginBottom: 4, paddingLeft: 20 }}>
                Inspired by the {implant.inspiredBy.toLowerCase()}
              </div>
            )}
            <div className="mirror-implant__body">
              <HealthBar value={implant.health} />
              <div className="mirror-implant__details">
                <span className="mirror-implant__health">{implant.health}%</span>
                {implant.primaryMetric && (
                  <span className="mirror-implant__metric">{implant.primaryMetric}</span>
                )}
              </div>
            </div>
            {(implant.status === 'locked' || implant.status === 'license_required') && implant.requiresPlugin && (
              <div className="mirror-implant__plugin">
                Requires: {implant.requiresPlugin}
              </div>
            )}
            {implant.status === 'unreachable' && implant.statusReason?.service && (
              <div className="mirror-implant__plugin" style={{ color: 'var(--m-hal-amber, #f59e0b)' }}>
                Service unreachable: {implant.statusReason.service}
              </div>
            )}
            {implant.status === 'collecting' && implant.statusReason?.message && (
              <div className="mirror-implant__plugin" style={{ color: 'rgba(255,255,255,0.5)' }}>
                {implant.statusReason.message}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// Agents list
function AgentsList({ agents }) {
  if (!agents || agents.length === 0) return null

  // Group by level
  const grouped = agents.reduce((acc, agent) => {
    const level = agent.level || 0
    if (!acc[level]) acc[level] = []
    acc[level].push(agent)
    return acc
  }, {})

  const levelNames = {
    0: 'Orchestrator',
    1: 'Manager',
    2: 'Specialist',
    3: 'Worker',
    4: 'Observer'
  }

  return (
    <div className="mirror-card">
      <div className="mirror-card__header">
        <AgentIcon />
        <span>Agent Mesh</span>
        <span className="mirror-card__count">{agents.length}</span>
      </div>
      <div className="mirror-agents">
        {Object.entries(grouped).sort(([a], [b]) => a - b).map(([level, levelAgents]) => (
          <div key={level} className="mirror-agent-group">
            <div className="mirror-agent-group__header">
              L{level}: {levelNames[level] || 'Custom'}
            </div>
            <div className="mirror-agent-group__list">
              {levelAgents.map(agent => (
                <div
                  key={agent.id}
                  className={`mirror-agent ${!agent.active ? 'mirror-agent--inactive' : ''}`}
                  style={{ '--agent-color': agent.color }}
                >
                  <span className="mirror-agent__dot" />
                  <span className="mirror-agent__name">{agent.name}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Plugins list
function PluginsList({ plugins }) {
  if (!plugins || plugins.length === 0) {
    return (
      <div className="mirror-card">
        <div className="mirror-card__header">
          <PluginIcon />
          <span>Plugins</span>
        </div>
        <div className="mirror-empty mirror-empty--small">No custom plugins installed</div>
      </div>
    )
  }

  return (
    <div className="mirror-card">
      <div className="mirror-card__header">
        <PluginIcon />
        <span>Plugins</span>
        <span className="mirror-card__count">{plugins.length}</span>
      </div>
      <div className="mirror-plugins">
        {plugins.map(plugin => (
          <div
            key={plugin.id}
            className={`mirror-plugin ${!plugin.enabled ? 'mirror-plugin--disabled' : ''}`}
          >
            <span className="mirror-plugin__name">{plugin.name}</span>
            <span className="mirror-plugin__version">v{plugin.version}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Main MirrorTab Component
 */
// Collapsible JSON viewer icon
const ChevronIcon = ({ expanded }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
)

// JSON Viewer component
function ReflectionDataViewer({ data }) {
  const [expanded, setExpanded] = useState(false)

  if (!data) return null

  return (
    <div className="mirror-json">
      <button
        className="mirror-json__toggle"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronIcon expanded={expanded} />
        <span>Reflection Data (JSON)</span>
        <span className="mirror-json__size">
          {JSON.stringify(data).length.toLocaleString()} bytes
        </span>
      </button>
      {expanded && (
        <div className="mirror-json__content">
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}

export default function MirrorTab() {
  const [consciousness, setConsciousness] = useState(null)
  const [loading, setLoading] = useState(true)
  const [regenerating, setRegenerating] = useState(false)
  const [error, setError] = useState(null)

  // Fetch reflection data
  const fetchReflection = useCallback(async (trigger = 'auto') => {
    try {
      setError(null)
      const data = await generateReflectionMap(trigger)
      setConsciousness(data)
    } catch (err) {
      console.error('[MirrorTab] Failed to fetch reflection:', err)
      setError('Failed to load reflection map')
    } finally {
      setLoading(false)
    }
  }, [])

  // Regenerate reflection map
  const handleRegenerate = useCallback(async () => {
    setRegenerating(true)
    invalidateReflectionCache()
    await fetchReflection('manual')
    setRegenerating(false)
  }, [fetchReflection])

  // Initial load
  useEffect(() => {
    fetchReflection()
  }, [fetchReflection])

  // Listen for plugin changes
  useEffect(() => {
    const handlePluginChange = async (event) => {
      console.log('[MirrorTab] Plugin changed:', event.detail)
      invalidateReflectionCache()
      await fetchReflection('plugin-event')
    }

    window.addEventListener('quox-plugin-change', handlePluginChange)
    return () => window.removeEventListener('quox-plugin-change', handlePluginChange)
  }, [fetchReflection])

  // MIRROR-THESIS T2: the thesis strip has its OWN data source (turn-stats)
  // and must NOT be gated on the reflection/consciousness map, which is the
  // slow, Qdrant-dependent part. The headline that states what the platform
  // IS should render even while the inventory below it is still loading.
  if (loading) {
    return (
      <div className="mirror">
        <ThesisStrip />
        <div className="mirror-loading">
          <div className="mirror-loading__spinner" />
          <p>Loading consciousness map...</p>
        </div>
      </div>
    )
  }

  if (error && !consciousness) {
    return (
      <div className="mirror">
        <ThesisStrip />
        <div className="mirror-error">
          <p>{error}</p>
          <button onClick={handleRegenerate}>Retry</button>
        </div>
      </div>
    )
  }

  return (
    <div className="mirror">
      {/* Header */}
      <div className="mirror__header">
        <div className="mirror__title">
          <MirrorIcon />
          <h2>Consciousness Map</h2>
          {consciousness?.generatedAt && (
            <span className="mirror__timestamp">
              Generated: {formatTimeago(consciousness.generatedAt)}
            </span>
          )}
        </div>
        <button
          className="mirror__regenerate"
          onClick={handleRegenerate}
          disabled={regenerating}
        >
          {regenerating ? (
            <>
              <span className="mirror-loading__spinner mirror-loading__spinner--small" />
              Regenerating...
            </>
          ) : (
            <>
              <RefreshIcon />
              Regenerate
            </>
          )}
        </button>
      </div>

      {/* MIRROR-THESIS T2: the opening statement, with live numbers */}
      <ThesisStrip />

      {/* Content — ordered awareness → authority → evidence */}
      <div className="mirror__content">
        {/* Left Column */}
        <div className="mirror__column">
          <IdentityCard
            identity={consciousness?.identity}
            health={consciousness?.health}
          />
          <HatCatalogueCard />
          <TurnToolLoadCard />
          <MemoryCard memory={consciousness?.memory} />
          <CapabilitiesCard capabilities={consciousness?.capabilities} />
        </div>

        {/* Center Column - Implants */}
        <div className="mirror__column mirror__column--wide">
          <ImplantsGrid implants={consciousness?.cognitiveImplants} />
        </div>

        {/* Right Column */}
        <div className="mirror__column">
          <AgentsList agents={consciousness?.agents} />
          <PluginsList plugins={consciousness?.plugins} />
        </div>
      </div>

      {/* JSON Viewer */}
      <ReflectionDataViewer data={consciousness} />
    </div>
  )
}

export { MirrorIcon }
