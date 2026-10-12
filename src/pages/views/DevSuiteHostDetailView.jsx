/**
 * DevSuiteHostDetailView — DEVSUITE-HUB Phase 7 drill-in.
 *
 * Route: /dev-suite/servers/:hostId, reached from the "Details" link on a
 * dev-suite host card (DevServersHubPanel.jsx). The hub lists hosts; this is
 * the page for ONE host: everything the hub already knows about it (registry
 * state, enabled capabilities, pack status, resident state, supervisor
 * state) as a header, then ONE TAB PER dev.* CAPABILITY the host's profile
 * could ever advertise.
 *
 * The point of this phase is the honesty of the tabs, not the tabs
 * themselves. Three states, matching the exact vocabulary the hub's
 * capability pills already settled on (see the "capability pill semantics"
 * comment block in DevServersHubPanel.jsx and
 * src/test/devSuiteCapabilityPillSemantics.test.jsx — a prior finding there
 * is what this file is careful NOT to repeat):
 *
 *   panel        capability is enabled on this host AND has a real,
 *                registered panel (capabilityPanelRegistry.js) -> a normal
 *                clickable tab, opens that panel.
 *   no-panel     capability is enabled on this host but nothing has been
 *                built for it yet -> a disabled tab (native <button disabled>,
 *                so it is neither clickable nor keyboard-focusable — no new
 *                CSS needed, `.qx-tab:disabled` already renders this
 *                correctly) that says "no panel yet" plainly, not silently.
 *   unavailable  capability is not something this host currently advertises
 *                (never declared, or declared but not enabled) -> also a
 *                disabled tab, with a reason that says which of those two it
 *                is. This must not read the same as "no panel yet": one is a
 *                product gap, the other is a fact about this specific host.
 *
 * The capability list itself is DERIVED (known ∪ enabled ∪ every capability
 * with a currently-registered panel), not hardcoded, for the same reason
 * DevServersHubPanel.jsx's capabilityLabel() derives rather than maintains a
 * map: a hand-maintained list goes stale the next time a capability is
 * added. Including registered-but-not-advertised capabilities (dev.plan is
 * the real example today — see panels/index.js's own note that no host
 * advertises it yet) means a host that doesn't have a capability still gets
 * an honest, visible "unavailable" tab for it rather than the tab just not
 * existing.
 *
 * Badges (pack/resident/supervisor) and the capabilityLabel() derivation are
 * imported from DevServersHubPanel.jsx rather than re-implemented, so the
 * hub card and this drill-in page can never read differently for the same
 * host. Panel content for each capability is imported the same way: via
 * capabilityPanelRegistry, not reimplemented (dev.register/dev.sessions/
 * dev.build/dev.plan already have real panels; see
 * components/devsuite/panels/index.js).
 *
 * Data sources — all pre-existing endpoints, none new:
 *   GET /api/v1/dev-servers                            (find this host's row)
 *   GET /api/v1/dev-servers/:hostId/skill-pack-status   (pack badge)
 *   POST /api/v1/dev-servers/:hostId/skill-pack-sync    (pack badge's "Sync now")
 *   GET /api/v1/dev-servers/:hostId/supervisor          (supervisor badge)
 *
 * The supervisor badge here is READ-ONLY (no toggle button): flipping
 * autonomy is a human-admin decision that already has a governed home on
 * QuoxperticusResidentView (/quoxperticus/:hostId, linked from this page's
 * header when the resident is real). Duplicating the write path here would
 * mean two places a switch flip could originate from for no product benefit;
 * this page's job is capability visibility, not a second governance control
 * surface.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { usePluginLicensed } from '../../hooks/usePluginLicensed'
import {
  capabilityLabel,
  PackStatusBadge,
  PackRightsChips,
  ResidentBadge,
  SupervisorBadge,
} from '../../components/core/devsuite/DevServersHubPanel'
// Side-effect import: registers the built-in capability panels (dev.register/
// dev.sessions/dev.plan) before this view resolves any of them. dev.build is
// NOT among them since the LL-7 quoxbuild strip — it registers itself from its
// own signed bundle on activation, and resolves to the locked slot until then.
import '../../components/devsuite/panels'
import {
  capabilityPanelState,
  getPremiumCapabilityPanel,
  getRegisteredCapabilities,
  resolveCapabilityPanel,
} from '../../config/capabilityPanelRegistry'
import './devsuite-host-detail.css'

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ResidentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" aria-hidden="true">
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

function DevSuiteHostLocked({ hostId }) {
  return (
    <div className="qx-view">
      <div className="qx-empty qx-card" data-testid="dev-suite-host-locked">
        <div className="qx-empty__title">Dev Servers is not licensed for this org</div>
        <div className="qx-empty__body">
          <code className="qx-code">{hostId}</code>'s capabilities live behind the dev-servers plugin.
          Enable it in Plugins to see them.
        </div>
      </div>
    </div>
  )
}

// The three-state derivation described in the file header. Pure function so
// the state logic is testable in isolation from the fetch/render plumbing.
export function describeCapabilityTab(cap, enabledSet, knownSet) {
  const panelState = capabilityPanelState(cap)
  const hasPanel = panelState !== 'none'
  const isEnabled = enabledSet.has(cap)

  // LICENSE-LAUNCH LL-7 quoxbuild strip: a fourth honest state. dev.build's
  // panel now ships inside a paid bundle, so an org with Dev Servers but not
  // QuoxBuild has a panel that EXISTS and is not loaded. Saying "no panel has
  // been built for it yet" there would be a lie about our own product; the tab
  // stays openable and shows the upsell instead.
  if (isEnabled && panelState === 'locked') {
    const meta = getPremiumCapabilityPanel(cap)
    return {
      state: 'locked',
      openable: true,
      reason: `${cap} ships with ${meta?.name || 'a paid plugin'}`,
    }
  }
  if (isEnabled && hasPanel) {
    return { state: 'panel', openable: true, reason: null }
  }
  if (isEnabled && !hasPanel) {
    return {
      state: 'no-panel',
      openable: false,
      reason: `${cap} is enabled here, but no panel has been built for it yet`,
    }
  }
  const isKnown = knownSet.has(cap)
  return {
    state: 'unavailable',
    openable: false,
    reason: isKnown
      ? `${cap} is not enabled on this host`
      : `${cap} is not advertised by this host's profile`,
  }
}

export default function DevSuiteHostDetailView() {
  const { hostId } = useParams()
  const licensed = usePluginLicensed('dev-servers')

  const [server, setServer] = useState(null)
  const [serverLoadedOnce, setServerLoadedOnce] = useState(false)
  const [packStatus, setPackStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [supervisorStatus, setSupervisorStatus] = useState(null)
  const [activeCap, setActiveCap] = useState(null)
  const [activeCapInitialized, setActiveCapInitialized] = useState(false)

  const fetchServer = useCallback(async () => {
    try {
      const res = await fetch('/collector/api/v1/dev-servers')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const list = Array.isArray(data.servers) ? data.servers : []
      setServer(list.find((s) => s.host_id === hostId) || null)
    } catch {
      // Best-effort — the header falls back to hostId-only identity.
    } finally {
      setServerLoadedOnce(true)
    }
  }, [hostId])

  const fetchPackStatus = useCallback(async () => {
    try {
      const res = await fetch(`/collector/api/v1/dev-servers/${encodeURIComponent(hostId)}/skill-pack-status`)
      if (!res.ok) return
      setPackStatus(await res.json())
    } catch {
      // Best-effort — the badge reads "pack status unknown" until it resolves.
    }
  }, [hostId])

  const fetchSupervisorStatus = useCallback(async () => {
    try {
      const res = await fetch(`/collector/api/v1/dev-servers/${encodeURIComponent(hostId)}/supervisor`)
      if (!res.ok) return
      setSupervisorStatus(await res.json())
    } catch {
      // Best-effort — the badge stays at its last known state.
    }
  }, [hostId])

  const handleSync = useCallback(async () => {
    setSyncing(true)
    try {
      const res = await fetch(`/collector/api/v1/dev-servers/${encodeURIComponent(hostId)}/skill-pack-sync`, { method: 'POST' })
      if (res.ok) await fetchPackStatus()
    } catch {
      // Best-effort — the badge simply stays at its last known status.
    } finally {
      setSyncing(false)
    }
  }, [hostId, fetchPackStatus])

  useEffect(() => {
    fetchServer()
    fetchPackStatus()
    fetchSupervisorStatus()
    const interval = setInterval(() => {
      fetchServer()
      fetchPackStatus()
      fetchSupervisorStatus()
    }, 10000)
    return () => clearInterval(interval)
  }, [fetchServer, fetchPackStatus, fetchSupervisorStatus])

  const enabledSet = useMemo(() => new Set(server?.enabled_capabilities || []), [server])
  const knownSet = useMemo(() => new Set(server?.known_capabilities || []), [server])

  // Derived, not hardcoded — see file header. Sorted for a stable render
  // order independent of server field order or registry registration order.
  const allCaps = useMemo(() => {
    return Array.from(new Set([
      ...(server?.known_capabilities || []),
      ...(server?.enabled_capabilities || []),
      ...getRegisteredCapabilities(),
    ])).sort()
  }, [server])

  const tabInfo = useMemo(() => {
    const map = {}
    for (const cap of allCaps) map[cap] = describeCapabilityTab(cap, enabledSet, knownSet)
    return map
  }, [allCaps, enabledSet, knownSet])

  // Pick a default active tab once the server has loaded (or failed to):
  // the first capability with a real panel, if any. Only runs once so a
  // user's own tab click is never overridden by the next 10s poll.
  useEffect(() => {
    if (activeCapInitialized || !serverLoadedOnce) return
    const firstOpenable = allCaps.find((cap) => tabInfo[cap]?.openable)
    setActiveCap(firstOpenable || null)
    setActiveCapInitialized(true)
  }, [activeCapInitialized, serverLoadedOnce, allCaps, tabInfo])

  const ActivePanel = activeCap ? resolveCapabilityPanel(activeCap) : null

  const residentLinkVisible = server && (server.resident_state === 'provisioned' || supervisorStatus?.updated_at)

  if (!licensed) return <DevSuiteHostLocked hostId={hostId} />

  return (
    <div className="qx-view dsh-view">
      <div className="dsh-toolbar">
        <Link to="/dev-suite" className="qx-btn qx-btn--ghost qx-btn--sm" data-testid="dev-suite-host-back">
          <BackIcon /> Dev Suite
        </Link>
        <h1 className="dsh-title">{server?.hostname || hostId}</h1>
        {residentLinkVisible && (
          <Link
            to={`/quoxperticus/${encodeURIComponent(hostId)}`}
            className="qx-btn qx-btn--ghost qx-btn--sm"
            data-testid="dev-suite-host-resident-link"
          >
            <ResidentIcon /> Resident
          </Link>
        )}
      </div>

      {/* HEADER: everything the hub already knows about this host. */}
      <header className="qx-card qx-card--compact dsh-header" data-testid="dev-suite-host-header">
        <div className="qx-row qx-row--tight dsh-header__badges">
          <span className="qx-pill qx-pill--sm qx-pill--ghost">{hostId}</span>
          {server?.profile_verified != null && (
            <span className={`qx-pill qx-pill--sm ${server.profile_verified ? 'qx-pill--online' : 'qx-pill--ghost'}`}>
              {server.profile_verified ? 'profile verified' : 'unverified'}
            </span>
          )}
          {server?.profile_version && <span className="qx-pill qx-pill--sm qx-pill--ghost">v{server.profile_version}</span>}
          <PackStatusBadge hostId={hostId} packStatus={packStatus} syncing={syncing} onSync={handleSync} />
          <PackRightsChips rights={packStatus?.rights} />
          <ResidentBadge residentState={server?.resident_state} residentDetail={server?.resident_detail} />
          {/* Read-only here on purpose — see file header. isAdmin gates the
              toggle button in this shared component; passing false hides it
              even for an admin viewer, so this page never becomes a second
              origin for the write. */}
          <SupervisorBadge hostId={hostId} supervisorStatus={supervisorStatus} isAdmin={false} toggling={false} onToggle={() => {}} />
        </div>

        {serverLoadedOnce && !server && (
          <div className="qx-hint qx-hint--warn" data-testid="dev-suite-host-not-found" style={{ marginTop: 10 }}>
            This host is not in the dev-servers registry. It may have never registered, or its host id
            does not match <code className="qx-code">{hostId}</code> exactly. Capability tabs below are shown as
            unavailable until it registers.
          </div>
        )}

        {server && (
          <div className="dsh-header__meta">
            {server.last_seen_at && <span className="qx-hint">last seen {relativeTime(server.last_seen_at)}</span>}
            {server.checked_at && <span className="qx-hint">checked {relativeTime(server.checked_at)}</span>}
            <span className="qx-hint">
              enabled: {(server.enabled_capabilities || []).length
                ? server.enabled_capabilities.map((c) => capabilityLabel(c)).join(', ')
                : 'none'}
            </span>
          </div>
        )}
      </header>

      {/* TABS: one per capability the host's profile could ever advertise. */}
      <div className="qx-tabs" role="tablist" aria-label="Host capabilities" data-testid="dev-suite-host-tabs">
        {allCaps.length === 0 && (
          <span className="qx-hint">No capabilities to show yet.</span>
        )}
        {allCaps.map((cap) => {
          const info = tabInfo[cap]
          if (info.openable) {
            return (
              <button
                key={cap}
                type="button"
                role="tab"
                aria-selected={activeCap === cap}
                className={`qx-tab${activeCap === cap ? ' qx-tab--active' : ''}`}
                onClick={() => setActiveCap(cap)}
                data-testid={`dev-suite-host-tab-${cap}`}
                data-state={info.state}
                data-openable="true"
                title={info.state === 'locked' ? info.reason : `View the ${cap} panel`}
              >
                {capabilityLabel(cap)}
              </button>
            )
          }
          // Native `disabled` — not clickable, not keyboard-focusable, and
          // `.qx-tab:disabled` (qx-components.css) already renders this
          // correctly (0.4 opacity, not-allowed cursor). No new CSS needed.
          return (
            <button
              key={cap}
              type="button"
              role="tab"
              aria-selected={false}
              disabled
              className="qx-tab"
              data-testid={`dev-suite-host-tab-${cap}`}
              data-state={info.state}
              data-openable="false"
              title={info.reason}
            >
              {capabilityLabel(cap)}
              <span className="dsh-tab__state"> — {info.state === 'no-panel' ? 'no panel yet' : 'unavailable'}</span>
            </button>
          )
        })}
      </div>

      {/* CONTENT: the active capability's real panel. */}
      {ActivePanel ? (
        <div className="qx-card" data-testid={`dev-suite-host-panel-${activeCap}`}>
          <ActivePanel server={server || { host_id: hostId }} />
        </div>
      ) : (
        <div className="qx-empty qx-card" data-testid="dev-suite-host-no-panel">
          <div className="qx-empty__title">No capability panel to show</div>
          <div className="qx-empty__body">
            {allCaps.length === 0
              ? 'This host has not reported any capabilities yet.'
              : 'None of this host’s capabilities have a real panel built yet. Check the tabs above for why each one is unavailable.'}
          </div>
        </div>
      )}
    </div>
  )
}
