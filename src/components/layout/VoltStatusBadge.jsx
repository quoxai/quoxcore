/**
 * VoltStatusBadge — VOLT evidence trail status for AppShell header
 *
 * Shows VOLT recording state at a glance. Follows SystemHealthBadge pattern:
 * colored dot + label + optional dropdown with live stats.
 *
 * States:
 *   - Off (gray):    voltEnabled is false in settings
 *   - Active (green): bridge enabled, 0 failures
 *   - Degraded (amber): bridge enabled, failures > 0
 *   - Error (red):   bridge enabled but not active
 */

import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getBridgeStats } from '../../lib/volt/volt-bridge'

function VoltStatusBadge() {
  const navigate = useNavigate()
  const [stats, setStats] = useState(null)
  const [bridgeStats, setBridgeStats] = useState(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const badgeRef = useRef(null)

  // THE SERVER DECIDES WHETHER VOLT IS ON. NOT THIS BROWSER.
  //
  // 2026-08-18: this badge read `voltEnabled` from localStorage and, finding it
  // absent, early-returned "VOLT Off" and never asked the server at all. It
  // printed VOLT Off in the footer of EVERY page, on every screenshot and every
  // demo, while /volt/stats reported 47,486 runs and 129,872 events and the
  // chain database was 88GB. A feature whose entire job is to report truthfully
  // was misreporting its own state, which is the same failure the Honesty
  // Ledger had, and it is worse here because it is on every page.
  //
  // Two rules were broken by the old shape and both are load-bearing:
  //   - localStorage is a CACHE, never a source of truth (the ZERO TOLERANCE
  //     persistence rule). A fresh browser, a cleared cache or a second device
  //     all reported a server-side fact as off.
  //   - "off by default until the browser says otherwise" inverts the burden of
  //     proof. Absence of a local flag is not evidence of an inactive chain.
  //
  // There are TWO VOLT producers and the old badge conflated them:
  //
  //   1. This browser's bridge, gated by the `voltEnabled` setting, which
  //      records UI-side events through the AEE bridge.
  //   2. The server-side emitter, which witnesses every tool call, agent run
  //      and governed action. It is not optional and never consulted the
  //      browser.
  //
  // The badge showed (1) and labelled it "VOLT", so a user who had simply never
  // turned on the browser bridge was told the whole evidence layer was off. The
  // headline now reflects (2), the system's actual state, and the browser
  // bridge appears in the dropdown as the per-tab detail it always was.
  const browserBridgeEnabled = JSON.parse(
    localStorage.getItem('quox-settings') || '{}'
  ).voltEnabled === true

  // Poll stats from the server, which is authoritative, with in-memory bridge
  // stats layered on for this tab's own recording health.
  useEffect(() => {
    const load = async () => {
      try {
        setBridgeStats(getBridgeStats())
        const res = await fetch('/collector/volt/stats', { signal: AbortSignal.timeout(5000) })
        if (res.ok) {
          setStats(await res.json())
        } else {
          // A failed probe is UNKNOWN, not off. Leaving stats null keeps the
          // badge in its neutral state rather than asserting a chain is dead
          // because one request 401'd or timed out.
          setStats(null)
        }
      } catch { /* fire-and-forget: unknown stays unknown */ }
    }
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return
    const handleClick = (e) => {
      if (badgeRef.current && !badgeRef.current.contains(e.target))
        setDropdownOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [dropdownOpen])

  const bs = bridgeStats || {}
  const hasFails = (bs.eventsFailed || 0) > 0
  // The server chain is the thing this badge is ABOUT. A browser bridge that
  // happens to be enabled is not evidence that anything was witnessed.
  const serverRecording = (stats?.runs > 0) || (stats?.events > 0)
  const statsLoaded = stats !== null

  let dotClass = 'status-dot--online'
  let label = 'VOLT'

  if (!statsLoaded) {
    // Unknown, not off. We have not heard back from the server yet, and
    // asserting either state here is how the old badge lied.
    dotClass = 'status-dot--degraded'
    label = 'VOLT …'
  } else if (!serverRecording) {
    // Server answered and genuinely has nothing. On a fresh install this is
    // true and worth saying plainly.
    dotClass = 'status-dot--degraded'
    label = 'VOLT: no events yet'
  } else if (hasFails) {
    dotClass = 'status-dot--degraded'
    label = `VOLT: ${bs.eventsFailed} failed`
  }

  const failed = bs.eventsFailed || 0
  const recorded = bs.eventsRecorded || stats?.events || 0
  const integrity = recorded > 0
    ? Math.round((recorded / (recorded + failed)) * 100)
    : 100

  return (
    <span
      className="app-shell__status-badge volt-badge"
      ref={badgeRef}
      onClick={() => setDropdownOpen(!dropdownOpen)}
      style={{ cursor: 'pointer' }}
    >
      <VoltIcon />
      <span className={`status-dot ${dotClass}`}></span>
      {label}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        style={{ width: 12, height: 12, marginLeft: 4, opacity: 0.6 }}>
        <polyline points={dropdownOpen ? "18 15 12 9 6 15" : "6 9 12 15 18 9"} />
      </svg>
      {dropdownOpen && (
        <div className="volt-badge-dropdown">
          <div className="volt-badge-dropdown__title">VOLT Evidence Trail</div>
          <div className="volt-badge-dropdown__stats">
            <div className="volt-badge-dropdown__row">
              <span>Events Recorded</span>
              <span className="volt-badge-dropdown__value">{(stats?.events || bs.eventsRecorded || 0).toLocaleString()}</span>
            </div>
            <div className="volt-badge-dropdown__row">
              <span>Events Failed</span>
              <span className={`volt-badge-dropdown__value ${hasFails ? 'volt-badge-dropdown__value--warn' : ''}`}>
                {bs.eventsFailed || 0}
              </span>
            </div>
            <div className="volt-badge-dropdown__row">
              <span>Runs</span>
              <span className="volt-badge-dropdown__value">{(stats?.runs || 0).toLocaleString()}</span>
            </div>
            <div className="volt-badge-dropdown__row">
              <span>Bundles</span>
              <span className="volt-badge-dropdown__value">{stats?.bundles || 0}</span>
            </div>
            {/*
              The per-tab detail that used to masquerade as the headline. Server
              recording is unaffected by it, so it is stated here, next to the
              server numbers, where the difference is obvious.
            */}
            <div className="volt-badge-dropdown__row">
              <span>This browser&rsquo;s bridge</span>
              <span className="volt-badge-dropdown__value">
                {browserBridgeEnabled ? 'on' : 'off (server still recording)'}
              </span>
            </div>
            <div className="volt-badge-dropdown__row">
              <span>Integrity</span>
              <span className={`volt-badge-dropdown__value ${integrity < 100 ? 'volt-badge-dropdown__value--warn' : ''}`}>
                {integrity}%
              </span>
            </div>
          </div>
          <button
            className="volt-badge-dropdown__link"
            onClick={(e) => { e.stopPropagation(); navigate('/volt'); setDropdownOpen(false) }}
          >
            View VOLT Dashboard
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      )}
    </span>
  )
}

const VoltIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginRight: 4 }}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <polyline points="9 12 11 14 15 10" />
  </svg>
)

export default VoltStatusBadge
