/**
 * WardSummaryCard — WARD receipt chain summary for DashboardView
 *
 * Shows 4-stat grid (receipts, chains, tips, integrity) + witness status.
 * When WARD is not available, shows a disabled state.
 */

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import './ward-summary.css'

function WardSummaryCard() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/collector/ward/stats')
        if (!res.ok) throw new Error()
        const json = await res.json()
        if (json.ok) setData(json)
        else setError(true)
      } catch {
        setError(true)
      }
    }
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [])

  if (error) {
    return (
      <div className="dashboard-card ward-summary-card ward-summary-card--disabled">
        <div className="dashboard-card__header">
          <div className="dashboard-card__title">
            <WardReceiptIcon />
            <span>WARD Receipt Chain</span>
          </div>
        </div>
        <div className="dashboard-card__body">
          <p className="ward-summary-card__disabled-text">
            WARD witnessing is not active. Receipt chain data will appear here when the collector is recording witnesses.
          </p>
        </div>
      </div>
    )
  }

  const s = data?.stats || {}
  const w = data?.witness || {}
  const integrityPct = w.witnessed > 0
    ? Math.round((w.witnessed / (w.witnessed + (w.errors || 0))) * 100)
    : 100

  return (
    <div className="dashboard-card ward-summary-card">
      <div className="ward-summary-card__accent" />
      <div className="dashboard-card__header">
        <div className="dashboard-card__title">
          <WardReceiptIcon />
          <span>WARD Receipt Chain</span>
        </div>
        <Link to="/ward" className="dashboard-card__link">View WARD</Link>
      </div>
      <div className="dashboard-card__body">
        <div className="ward-summary-card__stats">
          <div className="ward-summary-card__stat">
            <span className="ward-summary-card__stat-value">{s.entries || 0}</span>
            <span className="ward-summary-card__stat-label">receipts</span>
          </div>
          <div className="ward-summary-card__stat">
            <span className="ward-summary-card__stat-value">{s.chains || 0}</span>
            <span className="ward-summary-card__stat-label">chains</span>
          </div>
          <div className="ward-summary-card__stat">
            <span className="ward-summary-card__stat-value">{s.tips || 0}</span>
            <span className="ward-summary-card__stat-label">tips</span>
          </div>
          <div className="ward-summary-card__stat">
            <span className={`ward-summary-card__stat-value ${integrityPct < 100 ? 'ward-summary-card__stat-value--warn' : ''}`}>
              {integrityPct}%
            </span>
            <span className="ward-summary-card__stat-label">integrity</span>
          </div>
        </div>
        <div className="ward-summary-card__meta">
          <div className="ward-summary-card__meta-row">
            <span className={`status-dot ${w.witnessed > 0 ? 'status-dot--online' : 'status-dot--offline'}`}></span>
            <span>Witness: {w.witnessed > 0 ? 'Active' : 'Idle'}</span>
            {w.witnessed > 0 && (
              <span className="ward-summary-card__counter">{w.witnessed} witnessed / {w.duplicates || 0} skipped</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const WardReceiptIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 7h6M9 11h6M9 15h4" />
    <circle cx="17" cy="15" r="2" fill="currentColor" stroke="none" />
  </svg>
)

export default WardSummaryCard
