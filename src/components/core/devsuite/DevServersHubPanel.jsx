/**
 * DevServersHubPanel — Quox Dev Servers hub plugin panel
 *
 * DEVSUITE-HUB Phase 1 (docs/STREAM_DEVSUITE_HUB_PLAN.md): read-only inventory
 * grid of registered dev-mode hosts. Fetches the durable dev_servers registry
 * (GET /api/v1/dev-servers, services/collector/lib/devServersStore.js) and
 * renders one card per host: hostname/host_id, a profile-verified badge, and
 * its capabilities as pills (dev.register/dev.build/dev.clarify/dev.gripe/
 * dev.docs) — dimmed for known-but-not-enabled capabilities.
 *
 * Explicitly out of scope for this pass (DEVSUITE-BUILD's job): a build
 * queue view, a live log stream, or any terminal/PTY UI. Read-only fleet
 * visibility only. Mirrors GPUFleetPanel/AgentFleetPanel's data-fetching
 * pattern (10s poll, loading/error/empty states, monitoring.css classes).
 *
 * DEVSUITE-SKILLS Phase 3: each card also shows a skill-pack status badge
 * (GET /api/v1/dev-servers/:hostId/skill-pack-status,
 * services/collector/lib/devServerSkillPacksStore.js) — "pack current"
 * (green), "pack drifted, vN -> vM available" (amber), or "pack status
 * unknown" (grey) — plus a "Sync now" button for drifted hosts (POST
 * /api/v1/dev-servers/:hostId/skill-pack-sync). Reuses this codebase's
 * qx-pill convention (see StandingBadge.jsx), no new styling.
 *
 * DEVSUITE-HUB Phase 3: each capability pill is now clickable. Activating one
 * expands a per-server capability panel below the card, resolved via
 * ../../config/capabilityPanelRegistry — the registered panel component for
 * that capability if one exists, else an honest "no panel available yet"
 * fallback. Only dev.register has a real registered panel today (see
 * ./panels/DevRegisterPanel.jsx); this is the registry MECHANISM, not real
 * panel content for dev.build/dev.clarify/dev.gripe/dev.docs — those belong
 * to their own substreams.
 *
 * DEVSUITE-DEVMODE headless supervisor (quox#453 phase 15 follow-on): each
 * card also shows the resident's supervisor switch state (GET
 * /api/v1/dev-servers/:hostId/supervisor, services/collector/lib/
 * devServersStore.js) as a pill, plus an admin-only toggle button. The
 * toggle is the ONLY UI path to the write endpoint (PUT .../supervisor),
 * which the server gates with requireHumanAdmin() — turning autonomy on is
 * a human decision, never an agent or service-key one. `isAdmin` here is a
 * UI convenience only (hides a button a non-admin would just get a 403
 * from); the server-side gate is the actual invariant, so a non-admin who
 * somehow triggers the toggle still gets refused there.
 */

import { useState, useEffect, useCallback, memo, useRef } from 'react'
import { RIGHTS_SHORT_LABELS } from '../../../lib/skillRightsLabels'
import { Link } from 'react-router-dom'
import '../monitoring/monitoring.css'
import {
  resolveCapabilityPanel,
  capabilityPanelState,
  getPremiumCapabilityPanel,
  CAPABILITY_PANEL_CHANGE_EVENT,
} from '../../../config/capabilityPanelRegistry'
// Side-effect import: registers the built-in capability panels (currently
// just dev.register) into capabilityPanelRegistry before this panel renders.
// LICENSE-LAUNCH LL-7 extraction 2: panels/ stays at its original home
// (src/components/devsuite/panels/) rather than moving to core — many test
// files and DevSuiteHostDetailView import it directly from that path, and it
// is not itself a shared core primitive per the extraction spec, only this
// hub panel is. Only the relative path here changes for the new nesting.
import '../../devsuite/panels'
import { useWorkspace } from '../../../contexts/WorkspaceContext'

// QP-DASH P2+P3 — drill-in to the per-host resident page
// (/quoxperticus/:hostId), which makes the headless supervisor visible:
// alive/quiet/off, who holds its slot, what it has said, what it has spent.
// DEVSUITE-HUB Phase 7 — drill-in to the per-host capability detail page
// (/dev-suite/servers/:hostId), which turns "known_capabilities" and
// "enabled_capabilities" from a pill row on the card into one tab per
// capability, each honest about whether it has a real panel.
/**
 * The plugin a locked capability panel ships with, for the pill tooltip.
 * Metadata only (PREMIUM_CAPABILITY_PANELS) — never the panel component.
 */
function premiumPanelName(cap) {
  return getPremiumCapabilityPanel(cap)?.name || 'a paid plugin'
}

function DetailsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" strokeLinecap="round" />
    </svg>
  )
}

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

// Only for capabilities whose display name is NOT simply the id minus the
// `dev.` prefix. Everything else derives, so adding a capability cannot
// silently produce an odd one out.
//
// 2026-08-19: this was an exhaustive hardcoded map of five, and it had gone
// stale. dev.plan and dev.sessions fell through to `cap` and rendered as
// "dev.plan" and "dev.sessions" in a pill row that otherwise read
// "register build clarify gripe docs" — five bare, two prefixed, in the same
// row on the hub page. No assertion caught it because every pill was present
// and correct; it was only visible by LOOKING at the capture.
//
// A map that must be edited every time a capability is added will go stale
// again (the same shape as needing three registrations to add one capability
// at all), so the default now derives and the map holds exceptions only.
const CAPABILITY_LABEL_OVERRIDES = {}

export function capabilityLabel(cap) {
  if (CAPABILITY_LABEL_OVERRIDES[cap]) return CAPABILITY_LABEL_OVERRIDES[cap]
  return typeof cap === 'string' && cap.startsWith('dev.') ? cap.slice(4) : cap
}

// DEVSUITE-SKILLS Phase 3 — skill-pack status badge + "Sync now" for
// drifted hosts. `packStatus` is whatever GET .../skill-pack-status last
// returned for this host: { status, installedVersion, currentVersion,
// drifted } or null while it hasn't loaded yet.
// DEVSUITE-HUB Phase 7: exported so the per-host drill-in view
// (/dev-suite/servers/:hostId, pages/views/DevSuiteHostDetailView.jsx) can
// show the same badge in its header rather than re-deriving the pack-status
// display rules a second time.
export const PackStatusBadge = memo(function PackStatusBadge({ hostId, packStatus, syncing, onSync }) {
  if (!packStatus) {
    return (
      <span className="pack-status-badge qx-pill qx-pill--sm qx-pill--ghost" data-testid="pack-status-badge" data-status="unknown">
        pack status unknown
      </span>
    )
  }

  const { status, installedVersion, currentVersion } = packStatus

  if (status === 'current') {
    return (
      <span className="pack-status-badge qx-pill qx-pill--sm qx-pill--online" data-testid="pack-status-badge" data-status="current">
        pack current
      </span>
    )
  }

  if (status === 'drifted') {
    return (
      <span className="pack-status-wrap">
        <span className="pack-status-badge qx-pill qx-pill--sm qx-pill--warn" data-testid="pack-status-badge" data-status="drifted">
          pack drifted, v{installedVersion ?? '?'} &rarr; v{currentVersion ?? '?'} available
        </span>
        <button
          type="button"
          className="qx-btn qx-btn--sm"
          data-testid="sync-now-button"
          disabled={!!syncing}
          onClick={() => onSync(hostId)}
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </span>
    )
  }

  return (
    <span className="pack-status-badge qx-pill qx-pill--sm qx-pill--ghost" data-testid="pack-status-badge" data-status="unknown">
      pack status unknown
    </span>
  )
})

// SKILLRIGHTS #478 phase 11 (pricing-free slice) — rights chips beside the
// pack badge. Renders the skill-pack-status response's `rights` summary
// (summarizePackRights shape: declared/undeclared/byLicense) as qx-pills:
// one per licence with a count, plus a warn pill when anything is
// undeclared. Nothing here claims enforcement; it is capability visibility,
// same as every other badge on this row. Same qx-pill grammar, no bespoke
// CSS. Exported for the host detail view, matching PackStatusBadge.

export const PackRightsChips = memo(function PackRightsChips({ rights }) {
  if (!rights || !rights.total) return null
  const licences = Object.entries(rights.byLicense || {})
  return (
    <span className="pack-rights-chips" data-testid="pack-rights-chips">
      {licences.map(([id, n]) => (
        <span
          key={id}
          className="qx-pill qx-pill--sm qx-pill--ghost"
          data-testid="rights-chip"
          data-licence={id}
          title={`${n} skill${n === 1 ? '' : 's'} declared ${id}`}
        >
          {RIGHTS_SHORT_LABELS[id] || id} &times;{n}
        </span>
      ))}
      {rights.undeclared > 0 && (
        <span
          className="qx-pill qx-pill--sm qx-pill--warn"
          data-testid="rights-chip-undeclared"
          title={`${rights.undeclared} skill${rights.undeclared === 1 ? '' : 's'} in this pack carry no SkillRights declaration`}
        >
          undeclared &times;{rights.undeclared}
        </span>
      )}
    </span>
  )
})

// quox#453 phase 15 — resident identity badge. `residentState`/
// `residentDetail` are the dev_servers row's resident_state/resident_detail
// columns (services/collector/lib/devServersStore.js), stamped by the
// enable route right after it provisions (or fails to provision) the
// host's resident Ed25519 identity. A null state means "never attempted"
// (pre-phase-15 host, or enable not re-run since) — a neutral "resident:
// none", not a failure. Reuses the same qx-pill classes as PackStatusBadge;
// no bespoke styling.
// DEVSUITE-HUB Phase 7: exported for the same reason as PackStatusBadge above.
export const ResidentBadge = memo(function ResidentBadge({ residentState, residentDetail }) {
  if (residentState === 'provisioned') {
    return (
      <span className="resident-status-badge qx-pill qx-pill--sm qx-pill--online" data-testid="resident-status-badge" data-status="provisioned">
        resident provisioned
      </span>
    )
  }

  if (residentState === 'failed') {
    return (
      <span
        className="resident-status-badge qx-pill qx-pill--sm qx-pill--warn"
        data-testid="resident-status-badge"
        data-status="failed"
        title={residentDetail ? `resident identity provisioning failed: ${residentDetail}` : 'resident identity provisioning failed'}
      >
        resident failed
      </span>
    )
  }

  return (
    <span className="resident-status-badge qx-pill qx-pill--sm qx-pill--ghost" data-testid="resident-status-badge" data-status="none">
      resident: none
    </span>
  )
})

// quox#453 phase 15 follow-on, DEVSUITE-DEVMODE — headless supervisor
// switch. `supervisorStatus` is whatever GET .../supervisor last returned
// for this host (see DevServersHubPanel's fetchSupervisorStatus), or null
// while it hasn't loaded yet. `isAdmin` gates the toggle button only; the
// server enforces the real invariant (requireHumanAdmin) regardless of
// what this component renders.
// DEVSUITE-HUB Phase 7: exported for the same reason as PackStatusBadge above.
export const SupervisorBadge = memo(function SupervisorBadge({ hostId, supervisorStatus, isAdmin, toggling, onToggle }) {
  const enabled = !!(supervisorStatus && supervisorStatus.enabled)

  return (
    <span className="supervisor-status-wrap">
      <span
        className={`supervisor-status-badge qx-pill qx-pill--sm ${enabled ? 'qx-pill--online' : 'qx-pill--ghost'}`}
        data-testid="supervisor-status-badge"
        data-status={enabled ? 'active' : 'off'}
        title={
          supervisorStatus?.slot
            ? `supervisor ${enabled ? 'active' : 'off'} on slot ${supervisorStatus.slot}`
            : `supervisor ${enabled ? 'active' : 'off'}`
        }
      >
        {enabled ? 'supervisor active' : 'supervisor off'}
      </span>
      {isAdmin && (
        <button
          type="button"
          className="qx-btn qx-btn--sm"
          data-testid="supervisor-toggle-button"
          disabled={!!toggling}
          onClick={() => onToggle(hostId)}
        >
          {toggling ? 'Working…' : enabled ? 'Disable' : 'Enable'}
        </button>
      )}
    </span>
  )
})

// Single dev-server card
const DevServerCard = memo(function DevServerCard({ server, packStatus, syncing, onSync, expandedCapability, onTogglePanel, supervisorStatus, isAdmin, supervisorToggling, onSupervisorToggle, panelRegistryVersion = 0 }) {
  const {
    host_id,
    hostname,
    profile_verified,
    profile_version,
    enabled_capabilities = [],
    known_capabilities = [],
    last_seen_at,
    resident_state = null,
    resident_detail = null,
  } = server

  const enabledSet = new Set(enabled_capabilities)
  // Union of known + enabled, in case enabled ever carries something known didn't list
  const allCapabilities = Array.from(new Set([...known_capabilities, ...enabled_capabilities]))

  return (
    <div className="agent-card" data-testid="dev-server-card">
      <div className="agent-header">
        <div className="agent-name">
          <span className="host-id">{host_id}</span>
          <span
            className={`health-badge qx-pill qx-pill--sm ${profile_verified ? 'qx-pill--online' : 'qx-pill--ghost'}`}
            data-testid="profile-verified-badge"
          >
            {profile_verified ? 'profile verified' : 'unverified'}
          </span>
          <PackStatusBadge hostId={host_id} packStatus={packStatus} syncing={syncing} onSync={onSync} />
          <PackRightsChips rights={packStatus?.rights} />
          <ResidentBadge residentState={resident_state} residentDetail={resident_detail} />
          <SupervisorBadge
            hostId={host_id}
            supervisorStatus={supervisorStatus}
            isAdmin={isAdmin}
            toggling={supervisorToggling}
            onToggle={onSupervisorToggle}
          />
          <Link
            to={`/dev-suite/servers/${encodeURIComponent(host_id)}`}
            className="qx-btn qx-btn--ghost qx-btn--sm"
            data-testid="dev-server-details-link"
            title="Open this host: registry state, pack + resident + supervisor status, one tab per capability"
          >
            <DetailsIcon /> Details
          </Link>
          {/* Owner ruling 2026-08-23 (quox#474): a dev server is a quoxagent,
              not automatically a quoxperticus. The Resident link renders ONLY
              where the resident mode is real: the registry says the identity
              is provisioned, OR a human has ever configured its supervisor
              (updated_at set). The OR exists because the registry's
              resident_state can read null on a host whose resident is alive
              (quox#469 item 3, dev-box live case). */}
          {(resident_state === 'provisioned' || supervisorStatus?.updated_at) && (
            <Link
              to={`/quoxperticus/${encodeURIComponent(host_id)}`}
              className="qx-btn qx-btn--ghost qx-btn--sm"
              data-testid="dev-server-resident-link"
              title="Open the resident: presence, chat and spend"
            >
              <ResidentIcon /> Resident
            </Link>
          )}
        </div>
        {profile_version && (
          <div className="connection-status">v{profile_version}</div>
        )}
      </div>

      <div className="agent-system">
        <span>{hostname || host_id}</span>
        {last_seen_at && (
          <>
            <span className="separator">|</span>
            <span>last seen {new Date(last_seen_at).toLocaleString()}</span>
          </>
        )}
      </div>

      <div className="capabilities" data-testid="capability-pills">
        {allCapabilities.length === 0 && (
          <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem' }}>
            No capabilities reported
          </span>
        )}
        {/*
          A pill has THREE states, and the old markup collapsed them into two.
          Every capability rendered as a <button> reading "View <cap> panel",
          so `clarify`, `gripe` and `docs` invited a click and answered
          "No panel available for <cap> yet." Only dev.register, dev.sessions
          and dev.build actually have panels.

          That is the overloaded-pill defect from the bundle audit: a control
          that looks identical whether the capability is off, built, or merely
          declared teaches the user that clicking is a gamble. Honest states:

            enabled + panel      green, clickable, opens it
            enabled + locked     green, clickable, opens the upsell (LL-7)
            enabled + no panel   green dot, NOT clickable, says so on hover
            not enabled          ghost, NOT clickable, says so on hover

          The 'locked' state arrived with the LICENSE-LAUNCH LL-7 quoxbuild
          strip: dev.build's panel now ships in a paid bundle, so the free
          build has the metadata but not the code. It stays clickable on
          purpose — the click reveals what the plugin is and what it costs,
          which is a real answer, unlike "nothing has been built" (a lie, the
          panel exists) or a dead pill (no answer at all).

          The two genuinely-nothing-to-open states are still spans, not
          disabled buttons: an unbuilt panel should not be keyboard-focusable
          or announced as an action either.
        */}
        {allCapabilities.map(cap => {
          const isEnabled = enabledSet.has(cap)
          const panelState = capabilityPanelState(cap)
          const hasPanel = panelState !== 'none'
          const isLocked = panelState === 'locked'
          const isExpanded = expandedCapability === cap
          const openable = isEnabled && hasPanel

          if (!openable) {
            const why = !isEnabled
              ? `${cap} is not enabled on this host`
              : 'No panel for this capability yet'
            return (
              <span
                key={cap}
                className={`capability-tag qx-pill qx-pill--sm ${isEnabled ? 'qx-pill--online' : 'qx-pill--ghost'}`}
                title={why}
                data-testid={`capability-pill-${cap}`}
                data-enabled={isEnabled}
                data-has-panel={hasPanel}
                data-openable="false"
                style={{ opacity: isEnabled ? 0.75 : 0.5, cursor: 'default' }}
              >
                {capabilityLabel(cap)}
              </span>
            )
          }

          return (
            <button
              key={cap}
              type="button"
              className={`capability-tag qx-pill qx-pill--sm qx-pill--online ${isExpanded ? 'capability-tag--active' : ''}`}
              title={isLocked
                ? (isExpanded ? `Hide the ${cap} details` : `${cap} ships with ${premiumPanelName(cap)}: see what it does`)
                : (isExpanded ? `Hide the ${cap} panel` : `View the ${cap} panel`)}
              data-testid={`capability-pill-${cap}`}
              data-enabled="true"
              data-has-panel="true"
              data-panel-state={panelState}
              data-openable="true"
              data-expanded={isExpanded}
              aria-pressed={isExpanded}
              onClick={() => onTogglePanel(cap)}
              style={{ cursor: 'pointer', border: 'none' }}
            >
              {capabilityLabel(cap)}
            </button>
          )
        })}
      </div>

      {expandedCapability && (() => {
        const CapabilityPanel = resolveCapabilityPanel(expandedCapability)
        return (
          <div
            className="capability-panel"
            data-testid={`capability-panel-${expandedCapability}`}
            data-host-id={host_id}
            style={{ marginTop: '0.6rem', padding: '0.6rem 0.75rem', background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, fontSize: '0.8rem' }}
          >
            <CapabilityPanel server={server} />
          </div>
        )
      })()}
    </div>
  )
}, (prev, next) => {
  const ps = prev.server, ns = next.server
  return (
    ps.host_id === ns.host_id &&
    ps.profile_verified === ns.profile_verified &&
    ps.profile_version === ns.profile_version &&
    ps.checked_at === ns.checked_at &&
    ps.last_seen_at === ns.last_seen_at &&
    ps.enabled_capabilities?.length === ns.enabled_capabilities?.length &&
    ps.known_capabilities?.length === ns.known_capabilities?.length &&
    ps.resident_state === ns.resident_state &&
    ps.resident_detail === ns.resident_detail &&
    prev.syncing === next.syncing &&
    prev.expandedCapability === next.expandedCapability &&
    // LL-7: a capability panel can register or unregister at runtime now, and
    // the registry is not a prop — this counter is how the card hears about it.
    prev.panelRegistryVersion === next.panelRegistryVersion &&
    prev.packStatus?.status === next.packStatus?.status &&
    prev.packStatus?.installedVersion === next.packStatus?.installedVersion &&
    prev.packStatus?.currentVersion === next.packStatus?.currentVersion &&
    prev.isAdmin === next.isAdmin &&
    prev.supervisorToggling === next.supervisorToggling &&
    prev.supervisorStatus?.enabled === next.supervisorStatus?.enabled &&
    prev.supervisorStatus?.slot === next.supervisorStatus?.slot
  )
})

// Main panel
export default function DevServersHubPanel() {
  // quox#453 phase 15 follow-on, DEVSUITE-DEVMODE — the org role lives on the
  // workspace membership (currentOrg.membership.role), NOT on the auth user
  // object (see SlotsDeckPanel.jsx's identical note: `user.role` does not
  // exist). This is a UI convenience only — hides the toggle a non-admin
  // would just get a 403 from — the server's requireHumanAdmin() gate is the
  // real invariant regardless of what isAdmin reads here.
  const { currentOrg } = useWorkspace()
  const role = currentOrg?.membership?.role
  const isAdmin = role === 'admin' || role === 'owner'
  const [servers, setServers] = useState([])
  const [loading, setLoading] = useState(true)
  // Found by a proof-loop capture 2026-08-18: `loading` flips false on the
  // first response, so a poll that has not yet resolved painted the "no dev
  // servers" empty state over a populated hub. A fixed-timeout probe read 9
  // cards on one run and 0 on the next because of it. Same defect and same
  // fix as the Slots deck: only trust emptiness after a load that succeeded.
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [error, setError] = useState(null)
  // DEVSUITE-SKILLS Phase 3 — per-host skill-pack status, keyed by host_id.
  const [packStatuses, setPackStatuses] = useState({})
  const [syncingHosts, setSyncingHosts] = useState({})
  // quox#453 phase 15 follow-on — per-host supervisor switch state and
  // in-flight toggle tracking, keyed by host_id (same shape as packStatuses/
  // syncingHosts above).
  const [supervisorStatuses, setSupervisorStatuses] = useState({})
  const [togglingSupervisorHosts, setTogglingSupervisorHosts] = useState({})
  // DEVSUITE-HUB Phase 3 — which capability panel is expanded per host_id
  // (null/absent = none expanded). One panel open per card at a time.
  const [expandedPanels, setExpandedPanels] = useState({})
  const connectionIdRef = useRef(0)
  // LICENSE-LAUNCH LL-7 quoxbuild strip — capability panels are no longer all
  // registered at boot: a paid one (dev.build) registers when its signed
  // bundle activates and unregisters when the entitlement lapses. Without
  // this, a card memoised before activation would keep rendering the locked
  // slot until a reload, because the ServerCard memo compares server fields
  // and knows nothing about the registry.
  const [panelRegistryVersion, setPanelRegistryVersion] = useState(0)
  useEffect(() => {
    const onChange = () => setPanelRegistryVersion(v => v + 1)
    window.addEventListener(CAPABILITY_PANEL_CHANGE_EVENT, onChange)
    return () => window.removeEventListener(CAPABILITY_PANEL_CHANGE_EVENT, onChange)
  }, [])

  const handleTogglePanel = useCallback((hostId, capability) => {
    setExpandedPanels(prev => ({
      ...prev,
      [hostId]: prev[hostId] === capability ? null : capability,
    }))
  }, [])

  const fetchPackStatus = useCallback(async (hostId) => {
    const currentId = connectionIdRef.current
    try {
      const res = await fetch(`/collector/api/v1/dev-servers/${encodeURIComponent(hostId)}/skill-pack-status`)
      if (!res.ok) return
      const data = await res.json()
      if (connectionIdRef.current !== currentId) return
      setPackStatuses(prev => ({ ...prev, [hostId]: data }))
    } catch {
      // Best-effort — a stale/missing badge (renders as "unknown") is not
      // worth surfacing as a panel-level error.
    }
  }, [])

  const fetchSupervisorStatus = useCallback(async (hostId) => {
    const currentId = connectionIdRef.current
    try {
      const res = await fetch(`/collector/api/v1/dev-servers/${encodeURIComponent(hostId)}/supervisor`)
      if (!res.ok) return
      const data = await res.json()
      if (connectionIdRef.current !== currentId) return
      setSupervisorStatuses(prev => ({ ...prev, [hostId]: data }))
    } catch {
      // Best-effort — the badge simply reads as "off" (default) until the
      // next poll succeeds.
    }
  }, [])

  const fetchDevServers = useCallback(async () => {
    const currentId = connectionIdRef.current
    try {
      const res = await fetch('/collector/api/v1/dev-servers')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()

      if (connectionIdRef.current !== currentId) return

      const list = Array.isArray(data.servers) ? data.servers : []
      setServers(list)
      setError(null)
      setLoadedOnce(true)
      list.forEach(server => {
        fetchPackStatus(server.host_id)
        fetchSupervisorStatus(server.host_id)
      })
    } catch (err) {
      if (connectionIdRef.current === currentId) {
        setError(err.message)
      }
    } finally {
      if (connectionIdRef.current === currentId) {
        setLoading(false)
      }
    }
  }, [fetchPackStatus, fetchSupervisorStatus])

  // Flips `enabled`, resending the CURRENT slot/config alongside it — the
  // write endpoint is a full replace (absent fields fall back to their
  // documented defaults, server-side), so a toggle that only sent `enabled`
  // would silently clobber an existing slot/poll_seconds/etc back to
  // default on every click.
  const handleSupervisorToggle = useCallback(async (hostId) => {
    const current = supervisorStatuses[hostId]
    setTogglingSupervisorHosts(prev => ({ ...prev, [hostId]: true }))
    try {
      const res = await fetch(`/collector/api/v1/dev-servers/${encodeURIComponent(hostId)}/supervisor`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: !(current && current.enabled),
          slot: current?.slot ?? undefined,
          poll_seconds: current?.poll_seconds,
          turn_timeout_seconds: current?.turn_timeout_seconds,
          max_turns_per_hour: current?.max_turns_per_hour,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setSupervisorStatuses(prev => ({ ...prev, [hostId]: data }))
      } else {
        // A non-admin somehow reaching this (403) or a validation failure
        // (400) both surface the same way the rest of this panel surfaces
        // per-host errors: the badge stays at its last known state rather
        // than a panel-wide error banner for a single-host action.
        await fetchSupervisorStatus(hostId)
      }
    } catch {
      // Best-effort — refresh from the server rather than guess.
      fetchSupervisorStatus(hostId)
    } finally {
      setTogglingSupervisorHosts(prev => {
        const next = { ...prev }
        delete next[hostId]
        return next
      })
    }
  }, [supervisorStatuses, fetchSupervisorStatus])

  const handleSync = useCallback(async (hostId) => {
    setSyncingHosts(prev => ({ ...prev, [hostId]: true }))
    try {
      const res = await fetch(`/collector/api/v1/dev-servers/${encodeURIComponent(hostId)}/skill-pack-sync`, { method: 'POST' })
      if (res.ok) {
        await fetchPackStatus(hostId)
      }
    } catch {
      // Best-effort — the badge simply stays at its last known status.
    } finally {
      setSyncingHosts(prev => {
        const next = { ...prev }
        delete next[hostId]
        return next
      })
    }
  }, [fetchPackStatus])

  useEffect(() => {
    connectionIdRef.current++
    fetchDevServers()
    // FIRST-LOAD RESILIENCE (human-eyes review 2026-08-21): the dashboard
    // boot fires a large fetch storm that can starve this panel's first
    // fetch past the browser's per-host connection cap, leaving a human on
    // the LANDING tab staring at "Loading dev servers…" for a full poll
    // cycle. Fast exponential retries (1s, 2s, 4s) cover the storm without
    // waiting for the 10s poll; they stop the moment a load succeeds.
    const retries = [1000, 2000, 4000].map((ms) =>
      setTimeout(() => { if (!loadedOnce) fetchDevServers() }, ms))
    const interval = setInterval(fetchDevServers, 10000) // 10s steady poll
    return () => {
      connectionIdRef.current++
      retries.forEach(clearTimeout)
      clearInterval(interval)
    }
  }, [fetchDevServers, loadedOnce])

  return (
    <div className="agent-fleet-panel" data-testid="dev-servers-hub-panel">
      <div className="panel-header">
        <h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" style={{ marginRight: '0.5rem' }}>
            <rect x="2" y="3" width="20" height="6" rx="1" />
            <rect x="2" y="15" width="20" height="6" rx="1" />
            <circle cx="6" cy="6" r="1" fill="#38bdf8" />
            <circle cx="6" cy="18" r="1" fill="#38bdf8" />
          </svg>
          Dev Servers
        </h3>
        <div className="header-status">
          <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem' }}>
            {servers.length} host{servers.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {loading && (
        <div style={{ padding: '1rem', color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem' }} data-testid="dev-servers-loading">
          Loading dev servers…
        </div>
      )}

      {!loading && error && (
        <div className="error-banner" data-testid="dev-servers-error">
          <span>Dev servers fetch failed: {error}</span>
        </div>
      )}

      {!loading && !error && loadedOnce && servers.length === 0 && (
        <div style={{ padding: '1rem', color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem' }} data-testid="dev-servers-empty">
          <div>No dev servers registered yet.</div>
          <div style={{ marginTop: '0.35rem', fontSize: '0.78rem', color: 'rgba(255,255,255,0.35)' }}>
            Run <code>quox dev enable</code> on a host to register it as a dev server.
          </div>
        </div>
      )}

      {!loading && !error && servers.length > 0 && (
        <div className="agent-grid" data-testid="dev-servers-grid">
          {servers.map(server => (
            <DevServerCard
              key={server.host_id}
              server={server}
              packStatus={packStatuses[server.host_id] || null}
              syncing={!!syncingHosts[server.host_id]}
              onSync={handleSync}
              expandedCapability={expandedPanels[server.host_id] || null}
              onTogglePanel={(cap) => handleTogglePanel(server.host_id, cap)}
              supervisorStatus={supervisorStatuses[server.host_id] || null}
              isAdmin={isAdmin}
              supervisorToggling={!!togglingSupervisorHosts[server.host_id]}
              onSupervisorToggle={handleSupervisorToggle}
              panelRegistryVersion={panelRegistryVersion}
            />
          ))}
        </div>
      )}
    </div>
  )
}
