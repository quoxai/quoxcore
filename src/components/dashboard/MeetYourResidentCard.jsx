/**
 * MeetYourResidentCard, QUOXPERTICUS-REVISIT N1 (Discovery: un-hide the
 * resident, slice A).
 *
 * A first-touch, dismissible announcement on the dashboard home view for
 * Quoxperticus, Quox's governed resident agent. Before this slice there was
 * no nav entry and no announcement anywhere in the product. First-person,
 * warm, short copy; one CTA into the /quoxperticus landing page
 * (QuoxperticusLandingView.jsx); a real presence dot, never a fake green
 * (a dead or not-yet-provisioned resident reads as such, honestly).
 *
 * Only rendered for an org with the dev-servers plugin licensed, the same
 * gate the /quoxperticus nav row and route both honour (navRegistry.js,
 * QuoxperticusLandingView.jsx). An unlicensed org sees no promotional card
 * for a feature it cannot open, mirroring how every other pluginId-gated nav
 * row in this dashboard is simply absent rather than shown locked.
 *
 * Dismissal persistence: SERVER-SIDE via the existing global preferences
 * sync queue (src/services/serverSyncQueue.js, namespace
 * 'quoxperticusCardDismissed', wired into src/services/userPreferences.js's
 * NAMESPACE_MAP so it hydrates from users.preferences_json into localStorage
 * on login, the same mechanism every other dismissible/sticky UI preference
 * in this dashboard already uses (see defaultAssistant in HomeView.jsx for
 * the same read-localStorage-then-queueSync pattern). localStorage is only
 * the fast-read cache; the server preference is the source of truth.
 */

import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { isPluginLicensed } from '../../services/licenseValidator'
import { queueSync } from '../../services/serverSyncQueue'

const HEARTBEAT_FRESH_MS = 2 * 60 * 1000
const HEARTBEAT_DEAD_MS = 15 * 60 * 1000
const DISMISS_KEY = 'quox-quoxperticus-card-dismissed'

function ResidentGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" aria-hidden="true">
      <rect x="4" y="3" width="16" height="12" rx="2" />
      <path d="M9 21h6M12 15v6" strokeLinecap="round" />
      <circle cx="9" cy="9" r="1" fill="#38bdf8" />
      <circle cx="15" cy="9" r="1" fill="#38bdf8" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
    </svg>
  )
}

// Cheap, honest presence read for a home-page glyph: finds this org's FIRST
// resident host (same rule DevServersHubPanel's Resident link and
// QuoxperticusLandingView use: resident_state === 'provisioned', or a human
// has ever configured its supervisor) and reads its heartbeat. Skips the
// per-host "recent messages" refinement the detail page applies, same
// trade-off QuoxperticusLandingView documents.
async function fetchResidentPresence() {
  const res = await fetch('/collector/api/v1/dev-servers')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const list = Array.isArray(data.servers) ? data.servers : []

  let found = list.find((s) => s.resident_state === 'provisioned') || null
  const supervisorCache = {}
  if (!found) {
    for (const s of list) {
      try {
        const r = await fetch(`/collector/api/v1/dev-servers/${encodeURIComponent(s.host_id)}/supervisor`)
        if (r.ok) {
          const sup = await r.json()
          supervisorCache[s.host_id] = sup
          if (sup?.updated_at) { found = s; break }
        }
      } catch {
        // Best-effort: this host just doesn't count as a resident.
      }
    }
  }

  if (!found) return { hasResident: false, dot: 'qx-dot--idle', label: 'no resident yet' }

  const supervisor = supervisorCache[found.host_id]
    || await fetch(`/collector/api/v1/dev-servers/${encodeURIComponent(found.host_id)}/supervisor`).then((r) => (r.ok ? r.json() : null)).catch(() => null)

  if (!supervisor || !supervisor.enabled) {
    return { hasResident: true, dot: 'qx-dot--idle', label: 'disabled' }
  }

  let heartbeatAgeMs = null
  if (supervisor.slot) {
    try {
      const slotsRes = await fetch('/collector/api/v1/slots')
      if (slotsRes.ok) {
        const slotsData = await slotsRes.json()
        const slot = (Array.isArray(slotsData.slots) ? slotsData.slots : []).find((s) => s.name === supervisor.slot)
        if (slot?.last_heartbeat_at) heartbeatAgeMs = Date.now() - new Date(slot.last_heartbeat_at).getTime()
      }
    } catch {
      // Best-effort: presence just falls back to "quiet" below.
    }
  }

  if (heartbeatAgeMs != null && heartbeatAgeMs > HEARTBEAT_DEAD_MS) {
    return { hasResident: true, dot: 'qx-dot--offline', label: 'not responding' }
  }
  if (heartbeatAgeMs != null && heartbeatAgeMs < HEARTBEAT_FRESH_MS) {
    return { hasResident: true, dot: 'qx-dot--online', label: 'alive' }
  }
  return { hasResident: true, dot: 'qx-dot--degraded', label: 'quiet' }
}

export default function MeetYourResidentCard() {
  const navigate = useNavigate()
  const licensed = isPluginLicensed('dev-servers')

  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === 'true'
    } catch {
      return false
    }
  })
  // null = loading; a dead/unconfigured resident reads honestly, never a
  // fake green while we don't know yet.
  const [presence, setPresence] = useState(null)

  useEffect(() => {
    if (!licensed || dismissed) return undefined
    let cancelled = false
    const poll = async () => {
      try {
        const result = await fetchResidentPresence()
        if (!cancelled) setPresence(result)
      } catch {
        if (!cancelled) setPresence({ hasResident: false, dot: 'qx-dot--idle', label: 'unknown' })
      }
    }
    poll()
    const interval = setInterval(poll, 30000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [licensed, dismissed])

  const handleDismiss = useCallback(() => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, 'true')
    } catch {
      // Best-effort cache write; the server sync below is the source of truth.
    }
    queueSync('quoxperticusCardDismissed', true)
  }, [])

  if (!licensed || dismissed) return null

  return (
    <div className="qx-card" data-testid="meet-your-resident-card">
      <div className="qx-row qx-row--apart" style={{ alignItems: 'flex-start' }}>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <span
            className={`qx-dot ${presence?.dot || 'qx-dot--idle'}`}
            title={presence?.label || 'checking…'}
            data-testid="meet-your-resident-dot"
          />
          <ResidentGlyph />
        </div>
        <button
          type="button"
          className="qx-btn qx-btn--ghost qx-btn--sm"
          onClick={handleDismiss}
          data-testid="meet-your-resident-dismiss"
          aria-label="Dismiss"
        >
          <CloseIcon />
        </button>
      </div>
      <div style={{ marginTop: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Meet your resident</div>
        <p className="qx-hint" style={{ margin: 0 }}>
          I'm Quoxperticus. I live on this install, drive it like a first-time user, and file what
          breaks, with receipts.
        </p>
      </div>
      <div style={{ marginTop: 14 }}>
        <button
          type="button"
          className="qx-btn qx-btn--primary qx-btn--sm"
          onClick={() => navigate('/quoxperticus')}
          data-testid="meet-your-resident-cta"
        >
          Meet Quoxperticus
        </button>
      </div>
    </div>
  )
}
