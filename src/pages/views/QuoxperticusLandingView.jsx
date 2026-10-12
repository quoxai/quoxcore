/**
 * QuoxperticusLandingView, QUOXPERTICUS-REVISIT N1 (Discovery: un-hide the
 * resident, slice A).
 *
 * Route: /quoxperticus (no hostId). Quoxperticus is Quox's governed resident
 * agent; before this slice the only way to reach a resident's page was a
 * "Resident" button buried on a dev-server card at /infra, with no nav entry
 * and no announcement. This view lists this org's resident hosts as cards
 * and links each one into its detail page (QuoxperticusResidentView.jsx,
 * /quoxperticus/:hostId). If the org has exactly one resident host, it
 * auto-redirects there.
 *
 * Data sources, same as the per-host page and DevServersHubPanel:
 *   1. GET /collector/api/v1/dev-servers, the host inventory. A host counts
 *      as having a resident under the SAME rule DevServersHubPanel's Resident
 *      link uses (owner ruling 2026-08-23, quox#474: "a dev server is a
 *      quoxagent, not automatically a quoxperticus"): resident_state ===
 *      'provisioned', OR a human has ever configured its supervisor
 *      (supervisor.updated_at set, since resident_state can read null on a
 *      host whose resident is alive, quox#469 item 3).
 *   2. GET /collector/api/v1/dev-servers/:hostId/supervisor per host, slot
 *      plus enabled/disabled mode.
 *   3. GET /collector/api/v1/slots, heartbeat, for the presence dot.
 *
 * Presence dot: a CHEAP 3-state read of QuoxperticusResidentView's 4-state
 * algorithm (grey disabled, red not-responding for a stale heartbeat, green
 * alive for a fresh heartbeat, amber quiet as the fallback). The per-host
 * page refines "alive" further with a recent-messages check; this list view
 * skips that (it would mean an extra fetch per card) and links into the
 * per-host page for that detail, so a live resident never reads dead here,
 * it just reads "quiet" instead of the sharper "alive" the detail page can
 * show.
 *
 * Licence gating mirrors QuoxperticusResidentView.jsx exactly:
 * isPluginLicensed('dev-servers') inline, rendering an honest locked state
 * rather than fetching. This is a CORE, ungated route (see the comment above
 * its entry in routeRegistry.js), the same posture as DevServersHubPanel on
 * /infra, which renders for every org regardless of licence.
 *
 * ROUND 2 (owner-approved, 2026-09-26): the quox#474 "ever configured a
 * supervisor" test is loose enough that a host whose supervisor was touched
 * once and left disabled still counted as a "resident", over-implying how
 * many residents actually exist. This view's own PRIMARY/SECONDARY split
 * therefore uses a STRICTER signal than DevServersHubPanel's Resident link:
 * resident_state === 'provisioned' (an explicit resident-deployed flag) OR
 * supervisor.enabled === true (autonomy actually on), never mere presence/
 * heartbeat. Hosts that fail this render in a quieter SECONDARY group
 * ("Hosts without a resident yet") instead of being hidden or over-counted.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
// Reactive gate: re-checks on 'quox-entitlements-changed' so a cold deep
// link that renders before entitlements load does not stay locked.
import { usePluginLicensed } from '../../hooks/usePluginLicensed'

const HEARTBEAT_FRESH_MS = 2 * 60 * 1000
const HEARTBEAT_DEAD_MS = 15 * 60 * 1000

function ResidentIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" aria-hidden="true">
      <rect x="4" y="3" width="16" height="12" rx="2" />
      <path d="M9 21h6M12 15v6" strokeLinecap="round" />
      <circle cx="9" cy="9" r="1" fill="#38bdf8" />
      <circle cx="15" cy="9" r="1" fill="#38bdf8" />
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

// ONE naming rule, applied to every card with no per-card variation: prefer
// the bound resident slot's "quoxperticus-<suffix>" name (shortest, most
// recognisable per-host identifier) and fall back to hostname, then the bare
// host_id, only when no slot is bound. Different cards can still show
// different label shapes (numeric slot suffix vs hostname) because they have
// different underlying data, not because the rule itself varies.
function shortHostLabel(server, supervisor) {
  const slot = supervisor?.slot
  if (typeof slot === 'string') {
    const m = slot.match(/quoxperticus-(.+)$/i)
    if (m && m[1]) return m[1]
  }
  return server.hostname || server.host_id
}

function presenceFor(supervisor, slots) {
  if (!supervisor || !supervisor.enabled) return { dot: 'qx-dot--idle', label: 'disabled' }
  const slot = supervisor.slot ? slots.find((s) => s.name === supervisor.slot) : null
  const heartbeatAgeMs = slot?.last_heartbeat_at
    ? Date.now() - new Date(slot.last_heartbeat_at).getTime()
    : null
  if (slot && heartbeatAgeMs != null && heartbeatAgeMs > HEARTBEAT_DEAD_MS) {
    return { dot: 'qx-dot--offline', label: 'not responding' }
  }
  if (heartbeatAgeMs != null && heartbeatAgeMs < HEARTBEAT_FRESH_MS) {
    return { dot: 'qx-dot--online', label: 'alive' }
  }
  return { dot: 'qx-dot--degraded', label: 'quiet' }
}

function QuoxperticusLandingLocked() {
  // NOTE: deliberately different wording from QuoxperticusResidentView.jsx's
  // own locked state. That view's exact copy is a strip-markers.mjs
  // positive-control marker for the STRIPPED dev-servers plugin bundle
  // (scripts/strip-markers.mjs), and this file is a core, unstripped route.
  // Reusing that string verbatim here trips a false LEAK finding in
  // scan:dist and check:strip. Same honest message, different words.
  return (
    <div className="qx-view">
      <div className="qx-empty qx-card" data-testid="quoxperticus-landing-locked">
        <div className="qx-empty__icon"><ResidentIcon /></div>
        <div className="qx-empty__title">This org has not licensed Dev Servers</div>
        <div className="qx-empty__body">
          Quoxperticus is the resident that comes with the dev-servers plugin. Turn it on from
          Plugins to see presence, chat and spend for your host's resident.
        </div>
      </div>
    </div>
  )
}

export default function QuoxperticusLandingView() {
  const navigate = useNavigate()
  const licensed = usePluginLicensed('dev-servers')

  const [servers, setServers] = useState(null)
  const [supervisors, setSupervisors] = useState({})
  const [slots, setSlots] = useState([])
  const [error, setError] = useState(null)
  const [loadedOnce, setLoadedOnce] = useState(false)

  const fetchServers = useCallback(async () => {
    if (!licensed) return
    try {
      const res = await fetch('/collector/api/v1/dev-servers')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const list = Array.isArray(data.servers) ? data.servers : []
      setServers(list)
      setError(null)

      const entries = await Promise.all(
        list.map(async (s) => {
          try {
            const r = await fetch(`/collector/api/v1/dev-servers/${encodeURIComponent(s.host_id)}/supervisor`)
            if (!r.ok) return [s.host_id, null]
            return [s.host_id, await r.json()]
          } catch {
            return [s.host_id, null]
          }
        }),
      )
      setSupervisors(Object.fromEntries(entries))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadedOnce(true)
    }
  }, [licensed])

  const fetchSlots = useCallback(async () => {
    if (!licensed) return
    try {
      const res = await fetch('/collector/api/v1/slots')
      if (!res.ok) return
      const data = await res.json()
      setSlots(Array.isArray(data.slots) ? data.slots : [])
    } catch {
      // Best-effort: presence just falls back to "quiet" until the next poll.
    }
  }, [licensed])

  useEffect(() => {
    fetchServers()
    fetchSlots()
    const interval = setInterval(() => {
      fetchServers()
      fetchSlots()
    }, 15000)
    return () => clearInterval(interval)
  }, [fetchServers, fetchSlots])

  // PRIMARY: an explicit resident-deployed flag or autonomy actually on, the
  // strongest signals available (see the ROUND 2 file-header comment). Never
  // "ever configured" alone, and never mere host heartbeat/presence.
  const primaryResidents = useMemo(() => {
    if (!servers) return []
    return servers.filter(
      (s) => s.resident_state === 'provisioned' || supervisors[s.host_id]?.enabled === true,
    )
  }, [servers, supervisors])

  // SECONDARY: every other known dev host, i.e. no resident deployed here.
  const secondaryHosts = useMemo(() => {
    if (!servers) return []
    const primaryIds = new Set(primaryResidents.map((s) => s.host_id))
    return servers.filter((s) => !primaryIds.has(s.host_id))
  }, [servers, primaryResidents])

  useEffect(() => {
    if (loadedOnce && primaryResidents.length === 1) {
      navigate(`/quoxperticus/${encodeURIComponent(primaryResidents[0].host_id)}`, { replace: true })
    }
  }, [loadedOnce, primaryResidents, navigate])

  if (!licensed) return <QuoxperticusLandingLocked />

  return (
    <div className="qx-view" data-testid="quoxperticus-landing">
      <div className="qx-row qx-row--apart" style={{ alignItems: 'center', marginBottom: 4 }}>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <ResidentIcon />
          <h1 style={{ margin: 0, fontSize: 20 }}>Quoxperticus</h1>
        </div>
      </div>
      <p className="qx-hint" style={{ margin: '0 0 16px' }}>
        Your resident agents, one per server. They drive your install and file what breaks, with receipts.
      </p>

      {error && (
        <div className="qx-empty qx-card" data-testid="quoxperticus-landing-error">
          <div className="qx-empty__title">Could not load resident hosts</div>
          <div className="qx-empty__body">{error}</div>
        </div>
      )}

      {!error && !loadedOnce && (
        <div className="qx-stack qx-stack--tight">
          <div className="qx-skeleton qx-skeleton--line-sm" />
          <div className="qx-skeleton qx-skeleton--line-sm" style={{ width: '70%' }} />
        </div>
      )}

      {!error && loadedOnce && primaryResidents.length === 0 && (
        <div className="qx-empty qx-card" data-testid="quoxperticus-landing-empty">
          <div className="qx-empty__icon"><ResidentIcon /></div>
          <div className="qx-empty__title">No resident yet</div>
          <div className="qx-empty__body">
            No host on this org has a Quoxperticus resident configured. Enable the dev-mode
            agent profile on a host and give it a supervisor slot to bring one online.
            See <Link to="/infra">Dev Servers</Link> for the registered host inventory.
          </div>
        </div>
      )}

      {!error && loadedOnce && primaryResidents.length > 1 && (
        <div className="qx-grid-auto" data-testid="quoxperticus-landing-grid">
          {primaryResidents.map((server) => {
            const supervisor = supervisors[server.host_id]
            const presence = presenceFor(supervisor, slots)
            const label = shortHostLabel(server, supervisor)
            return (
              <Link
                key={server.host_id}
                to={`/quoxperticus/${encodeURIComponent(server.host_id)}`}
                className="qx-card qx-card--lift"
                data-testid="quoxperticus-landing-card"
              >
                <div className="qx-row qx-row--tight" style={{ alignItems: 'center', marginBottom: 8 }}>
                  <span className={`qx-dot ${presence.dot}`} title={presence.label} data-testid="quoxperticus-landing-dot" />
                  <strong>Quoxperticus {label}</strong>
                </div>
                <div className="qx-hint">{server.host_id}</div>
                <div className="qx-row qx-row--tight" style={{ marginTop: 12, alignItems: 'center' }}>
                  <span className={`qx-pill qx-pill--sm ${supervisor?.enabled ? 'qx-pill--online' : 'qx-pill--ghost'}`}>
                    {supervisor?.enabled ? 'autonomy on' : 'autonomy off'}
                  </span>
                  <span className="qx-hint">{presence.label}</span>
                </div>
                {server.last_seen_at && (
                  <div className="qx-hint" style={{ marginTop: 6 }}>host last seen {relativeTime(server.last_seen_at)}</div>
                )}
              </Link>
            )
          })}
        </div>
      )}

      {!error && loadedOnce && secondaryHosts.length > 0 && (
        <div style={{ marginTop: 28 }} data-testid="quoxperticus-landing-secondary">
          <div className="qx-hint" style={{ marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Hosts without a resident yet
          </div>
          <div className="qx-grid-auto" data-testid="quoxperticus-landing-secondary-grid">
            {secondaryHosts.map((server) => (
              <div
                key={server.host_id}
                className="qx-card qx-card--compact"
                style={{ opacity: 0.55 }}
                data-testid="quoxperticus-landing-secondary-card"
              >
                <strong>{server.hostname || server.host_id}</strong>
                <div className="qx-hint" style={{ marginTop: 4 }}>
                  No resident deployed here. A Quoxperticus resident could run on this host.
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
