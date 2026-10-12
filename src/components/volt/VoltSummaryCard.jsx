/**
 * VoltSummaryCard — VOLT evidence trail summary for DashboardView
 *
 * Shows 4-stat grid (events, runs, bundles, integrity) + bridge status.
 * When VOLT is disabled, shows a CTA to enable it.
 *
 * SERVER-FIRST: the headline evidence numbers (events/runs/bundles) are
 * read from volt.db via the collector — the authoritative, tamper-evident
 * store. IndexedDB is only a fallback cache when the server is
 * unreachable; "Bridge" status/failed-count reflect this tab's live
 * local event-transport health, not the persisted evidence count.
 */

import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getBridgeStats } from '../../lib/volt/volt-bridge'
import { getStoreStats } from '../../lib/volt/volt-store'
import { fetchVoltStats } from '../../lib/volt/volt-api'
import './volt-summary.css'

function VoltSummaryCard() {
  const navigate = useNavigate()
  const [stats, setStats] = useState(null)
  const [bridgeStats, setBridgeStats] = useState(null)
  const [offline, setOffline] = useState(false)

  const voltEnabled = JSON.parse(
    localStorage.getItem('quox-settings') || '{}'
  ).voltEnabled

  useEffect(() => {
    if (!voltEnabled) return
    const load = async () => {
      setBridgeStats(getBridgeStats())

      // Server is the source of truth for evidence counts.
      try {
        const s = await fetchVoltStats()
        setStats(s)
        setOffline(false)
        return
      } catch { /* server unreachable — fall through to offline cache */ }

      // Offline fallback ONLY — never the default path.
      try {
        const s = await getStoreStats()
        setStats(s)
        setOffline(true)
      } catch { /* both unavailable */ }
    }
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [voltEnabled])

  if (!voltEnabled) {
    return (
      <div className="dashboard-card volt-summary-card volt-summary-card--disabled">
        <div className="dashboard-card__header">
          <div className="dashboard-card__title">
            <VoltShieldIcon />
            <span>VOLT Evidence Trail</span>
          </div>
        </div>
        <div className="dashboard-card__body">
          <p className="volt-summary-card__disabled-text">
            VOLT is not enabled. Enable hash-chained audit trails in Settings to start recording tamper-evident traces.
          </p>
          <button
            className="volt-summary-card__cta"
            onClick={() => navigate('/settings#general')}
          >
            Enable VOLT
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>
    )
  }

  const bs = bridgeStats || {}
  const integrity = bs.eventsRecorded > 0
    ? Math.round((bs.eventsRecorded / (bs.eventsRecorded + (bs.eventsFailed || 0))) * 100)
    : 100

  const enabledAt = bs.enabledAt
    ? new Date(bs.enabledAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div className="dashboard-card volt-summary-card">
      <div className="volt-summary-card__accent" />
      <div className="dashboard-card__header">
        <div className="dashboard-card__title">
          <VoltShieldIcon />
          <span>VOLT Evidence Trail</span>
          {offline && (
            <span
              className="volt-summary-card__offline-pill"
              title="Server unreachable — showing last-known cached counts from this device"
            >
              cached
            </span>
          )}
        </div>
        <Link to="/volt" className="dashboard-card__link">View VOLT</Link>
      </div>
      <div className="dashboard-card__body">
        <div className="volt-summary-card__stats">
          <div className="volt-summary-card__stat">
            <span className="volt-summary-card__stat-value">{stats?.events || 0}</span>
            <span className="volt-summary-card__stat-label">events</span>
          </div>
          <div className="volt-summary-card__stat">
            <span className="volt-summary-card__stat-value">{stats?.runs || 0}</span>
            <span className="volt-summary-card__stat-label">runs</span>
          </div>
          <div className="volt-summary-card__stat">
            <span className="volt-summary-card__stat-value">{stats?.bundles || 0}</span>
            <span className="volt-summary-card__stat-label">bundles</span>
          </div>
          <div className="volt-summary-card__stat">
            <span className={`volt-summary-card__stat-value ${integrity < 100 ? 'volt-summary-card__stat-value--warn' : ''}`}>
              {integrity}%
            </span>
            <span className="volt-summary-card__stat-label">integrity</span>
          </div>
        </div>
        <div className="volt-summary-card__meta">
          <div className="volt-summary-card__meta-row">
            <span className={`status-dot ${bs.enabled ? 'status-dot--online' : 'status-dot--offline'}`}></span>
            <span>Bridge: {bs.enabled ? 'Active' : 'Inactive'}{enabledAt ? ` since ${enabledAt}` : ''}</span>
          </div>
          {(bs.eventsFailed || 0) > 0 && (
            <div className="volt-summary-card__meta-row volt-summary-card__meta-row--warn">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span>{bs.eventsFailed} event{bs.eventsFailed !== 1 ? 's' : ''} failed</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const VoltShieldIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <polyline points="9 12 11 14 15 10" />
  </svg>
)

export default VoltSummaryCard
