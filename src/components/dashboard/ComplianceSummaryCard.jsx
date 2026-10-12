/**
 * ComplianceSummaryCard — Compliance posture summary for DashboardView
 *
 * Reuses useComplianceData — the same hook ComplianceView drives — so this
 * card can never compute a different posture % than the full Compliance
 * Command Center. Shows posture %, controls passing/total (aggregated
 * across frameworks), frameworks tracked, and open findings.
 *
 * NEVER fabricates a number: if no compliance report has ever been
 * generated, posture.overallScore is null (see useComplianceData's
 * fetchPosture — `scores.length === 0 ? null : ...`), and this card shows
 * a disabled state rather than a fake percentage.
 */

import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useComplianceData } from '../../hooks/useComplianceData'
import './compliance-summary.css'

function ComplianceSummaryCard() {
  const { posture, frameworks, loading, error, refresh } = useComplianceData()

  useEffect(() => {
    const interval = setInterval(refresh, 60000)
    return () => clearInterval(interval)
  }, [refresh])

  const p = posture || {}
  const notConfigured = !loading && (!!error || p.overallScore === null || p.overallScore === undefined)

  if (notConfigured) {
    return (
      <div className="dashboard-card compliance-summary-card compliance-summary-card--disabled">
        <div className="dashboard-card__header">
          <div className="dashboard-card__title">
            <ComplianceIcon />
            <span>Compliance</span>
          </div>
        </div>
        <div className="dashboard-card__body">
          <p className="compliance-summary-card__disabled-text">
            Compliance posture is not available yet. Generate a compliance report to see coverage, controls, and open findings here.
          </p>
        </div>
      </div>
    )
  }

  const frameworkList = frameworks || []
  const controlsTotal = frameworkList.reduce((sum, f) => sum + (f.controlsTotal || 0), 0)
  const controlsMet = frameworkList.reduce((sum, f) => sum + (f.controlsMet || 0), 0)
  const frameworksTracked = frameworkList.filter((f) => f.status !== 'not_measured').length
  const openFindings = (p.risks || []).length
  const overallScore = p.overallScore ?? 0

  return (
    <div className="dashboard-card compliance-summary-card">
      <div className="compliance-summary-card__accent" />
      <div className="dashboard-card__header">
        <div className="dashboard-card__title">
          <ComplianceIcon />
          <span>Compliance</span>
        </div>
        <Link to="/compliance" className="dashboard-card__link">View compliance</Link>
      </div>
      <div className="dashboard-card__body">
        <div className="compliance-summary-card__stats">
          <div className="compliance-summary-card__stat">
            <span className={`compliance-summary-card__stat-value ${overallScore < 60 ? 'compliance-summary-card__stat-value--warn' : ''}`}>
              {overallScore}%
            </span>
            <span className="compliance-summary-card__stat-label">posture</span>
          </div>
          <div className="compliance-summary-card__stat">
            <span className="compliance-summary-card__stat-value">{controlsMet}/{controlsTotal}</span>
            <span className="compliance-summary-card__stat-label">controls</span>
          </div>
          <div className="compliance-summary-card__stat">
            <span className="compliance-summary-card__stat-value">{frameworksTracked}</span>
            <span className="compliance-summary-card__stat-label">frameworks</span>
          </div>
          <div className="compliance-summary-card__stat">
            <span className={`compliance-summary-card__stat-value ${openFindings > 0 ? 'compliance-summary-card__stat-value--warn' : ''}`}>
              {openFindings}
            </span>
            <span className="compliance-summary-card__stat-label">findings</span>
          </div>
        </div>
        <div className="compliance-summary-card__meta">
          <div className="compliance-summary-card__meta-row">
            <span className={`status-dot ${p.degraded ? 'status-dot--offline' : 'status-dot--online'}`}></span>
            <span>
              {p.degraded
                ? `Degraded: ${(p.unavailable || []).join(', ')} unreachable`
                : `Last audit: ${p.lastAudit || 'never'}`}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

const ComplianceIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
)

export default ComplianceSummaryCard
