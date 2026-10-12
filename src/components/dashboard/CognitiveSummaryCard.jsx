/**
 * CognitiveSummaryCard — Cognitive Topology summary for DashboardView
 *
 * Shows core health %, service count, and faculty/implant reporting count
 * from cognitiveTopologyService's getCoreHealth()/fetchAllImplantData().
 *
 * Cold-start handling: getCoreHealth() returns status 'unknown' (with
 * overallHealth 0, totalServices 0) when the health check times out or has
 * not collected any services yet. That case is rendered as "Warming up",
 * never as a fabricated "0% / critical" reading.
 */

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getCoreHealth, fetchAllImplantData, getLockedImplants } from '../../services/cognitiveTopologyService'
import './cognitive-summary.css'

function CognitiveSummaryCard() {
  const [core, setCore] = useState(null)
  const [implants, setImplants] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [coreHealth, implantData] = await Promise.all([
          getCoreHealth(),
          fetchAllImplantData(),
        ])
        if (cancelled) return
        setCore(coreHealth)
        setImplants(implantData)
      } catch {
        if (!cancelled) setError(true)
      }
    }
    load()
    const interval = setInterval(load, 30000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  if (error) {
    return (
      <div className="dashboard-card cognitive-summary-card cognitive-summary-card--disabled">
        <div className="dashboard-card__header">
          <div className="dashboard-card__title">
            <CognitiveNetworkIcon />
            <span>Cognitive Topology</span>
          </div>
        </div>
        <div className="dashboard-card__body">
          <p className="cognitive-summary-card__disabled-text">
            Cognitive Topology data is not available right now. Core health and faculty
            stats will appear here once the core services respond.
          </p>
        </div>
      </div>
    )
  }

  if (!core) {
    return (
      <div className="dashboard-card cognitive-summary-card cognitive-summary-card--disabled">
        <div className="dashboard-card__header">
          <div className="dashboard-card__title">
            <CognitiveNetworkIcon />
            <span>Cognitive Topology</span>
          </div>
        </div>
        <div className="dashboard-card__body">
          <p className="cognitive-summary-card__disabled-text">Loading core health…</p>
        </div>
      </div>
    )
  }

  // getCoreHealth() falls back to { overallHealth: 0, totalServices: 0,
  // status: 'unknown' } on timeout/failure. That is a cold-start/unavailable
  // signal, not a real 0% critical reading — render it as "Warming up".
  const coldStart = core.status === 'unknown' || core.totalServices === 0

  const implantList = Object.values(implants || {})
  const totalFaculties = implantList.length
  const reportingFaculties = implantList.filter(
    (im) => im && im.healthScore !== null && im.healthScore !== undefined && !im.fallback && !im.failureReason
  ).length
  const lockedCount = getLockedImplants().length

  if (coldStart) {
    return (
      <div className="dashboard-card cognitive-summary-card">
        <div className="cognitive-summary-card__accent" />
        <div className="dashboard-card__header">
          <div className="dashboard-card__title">
            <CognitiveNetworkIcon />
            <span>Cognitive Topology</span>
          </div>
          <Link to="/topology" className="dashboard-card__link">View topology</Link>
        </div>
        <div className="dashboard-card__body">
          <div className="cognitive-summary-card__warming">
            <span className="status-dot status-dot--offline"></span>
            <span>Warming up — core health is still collecting</span>
          </div>
          {totalFaculties > 0 && (
            <div className="cognitive-summary-card__meta-row">
              <span className="cognitive-summary-card__counter">
                {reportingFaculties}/{totalFaculties} faculties reporting
              </span>
            </div>
          )}
        </div>
      </div>
    )
  }

  const statusLabel =
    core.status === 'operational' ? 'Operational' : core.status === 'degraded' ? 'Degraded' : 'Critical'

  return (
    <div className="dashboard-card cognitive-summary-card">
      <div className="cognitive-summary-card__accent" />
      <div className="dashboard-card__header">
        <div className="dashboard-card__title">
          <CognitiveNetworkIcon />
          <span>Cognitive Topology</span>
        </div>
        <Link to="/topology" className="dashboard-card__link">View topology</Link>
      </div>
      <div className="dashboard-card__body">
        <div className="cognitive-summary-card__stats">
          <div className="cognitive-summary-card__stat">
            <span
              className={`cognitive-summary-card__stat-value ${
                core.overallHealth < 70 ? 'cognitive-summary-card__stat-value--warn' : ''
              }`}
            >
              {core.overallHealth}%
            </span>
            <span className="cognitive-summary-card__stat-label">core health</span>
          </div>
          <div className="cognitive-summary-card__stat">
            <span className="cognitive-summary-card__stat-value">
              {core.activeServices}/{core.totalServices}
            </span>
            <span className="cognitive-summary-card__stat-label">services</span>
          </div>
          <div className="cognitive-summary-card__stat">
            <span className="cognitive-summary-card__stat-value">
              {reportingFaculties}/{totalFaculties}
            </span>
            <span className="cognitive-summary-card__stat-label">faculties</span>
          </div>
        </div>
        <div className="cognitive-summary-card__meta">
          <div className="cognitive-summary-card__meta-row">
            <span className={`status-dot ${core.status === 'operational' ? 'status-dot--online' : 'status-dot--offline'}`}></span>
            <span>Core: {statusLabel}</span>
            {lockedCount > 0 && (
              <span className="cognitive-summary-card__counter">{lockedCount} locked</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const CognitiveNetworkIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="18" cy="6" r="2.2" />
    <circle cx="12" cy="12" r="2.2" />
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="18" r="2.2" />
    <path d="M7.8 7.6L10.3 10.4M16.2 7.6L13.7 10.4M10.3 13.6L7.8 16.4M13.7 13.6L16.2 16.4" />
  </svg>
)

export default CognitiveSummaryCard
