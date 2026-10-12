import { useState } from 'react'
import { calculateBlastRadius, getBlastRadiusColor, isProductionHost, isCriticalHost } from '../../utils/blastRadiusCalculator'
import './safety.css'

/**
 * MultiHostApproval - Approval gate for operations affecting multiple hosts
 * Shows blast radius visualization and requires confirmation
 */
export function MultiHostApproval({
  operation,
  hosts = [],
  totalHosts = 50,
  onApprove,
  onCancel
}) {
  const [confirmed, setConfirmed] = useState(false)

  const blastRadius = calculateBlastRadius(hosts, totalHosts)
  const color = getBlastRadiusColor(blastRadius.level)

  // Determine if this needs extra confirmation
  const needsDoubleConfirm = blastRadius.level === 'critical' || blastRadius.level === 'high'

  const handleApprove = () => {
    if (needsDoubleConfirm && !confirmed) {
      setConfirmed(true)
      return
    }
    onApprove()
  }

  // Separate hosts by type
  const productionHosts = hosts.filter(isProductionHost)
  const criticalHosts = hosts.filter(isCriticalHost).filter(h => !productionHosts.includes(h))
  const regularHosts = hosts.filter(h => !productionHosts.includes(h) && !criticalHosts.includes(h))

  return (
    <div className="multi-host-overlay" onClick={onCancel}>
      <div className="multi-host-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="multi-host-header">
          <div className="multi-host-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
          </div>
          <div className="multi-host-title">
            <h2>Multi-Host Operation</h2>
            <p>{blastRadius.message}</p>
          </div>
          <span className="multi-host-badge" style={{ background: `${color}20`, color }}>
            {blastRadius.level.toUpperCase()}
          </span>
        </div>

        {/* Body */}
        <div className="multi-host-body">
          {/* Blast Radius Visualization */}
          <div className="blast-radius">
            <div className="blast-radius-header">
              <span className="blast-radius-label">Blast Radius</span>
              <span className={`blast-radius-count ${blastRadius.level}`}>
                {blastRadius.count} hosts ({blastRadius.percentage}%)
              </span>
            </div>
            <div className="blast-radius-bar">
              <div
                className={`blast-radius-fill ${blastRadius.level}`}
                style={{ width: `${Math.min(100, blastRadius.percentage * 2)}%` }}
              />
            </div>
          </div>

          {/* Operation Details */}
          {operation && (
            <div className="multi-host-operation">
              <div className="host-list-label">Operation</div>
              <pre className="multi-host-query">{operation}</pre>
            </div>
          )}

          {/* Production Hosts */}
          {productionHosts.length > 0 && (
            <div className="host-list">
              <div className="host-list-label">
                Production Hosts ({productionHosts.length})
              </div>
              <div className="host-chips">
                {productionHosts.slice(0, 10).map(host => (
                  <span key={host} className="host-chip production">{host}</span>
                ))}
                {productionHosts.length > 10 && (
                  <span className="host-more">+{productionHosts.length - 10} more</span>
                )}
              </div>
            </div>
          )}

          {/* Critical Hosts */}
          {criticalHosts.length > 0 && (
            <div className="host-list">
              <div className="host-list-label">
                Critical Infrastructure ({criticalHosts.length})
              </div>
              <div className="host-chips">
                {criticalHosts.slice(0, 10).map(host => (
                  <span key={host} className="host-chip production">{host}</span>
                ))}
                {criticalHosts.length > 10 && (
                  <span className="host-more">+{criticalHosts.length - 10} more</span>
                )}
              </div>
            </div>
          )}

          {/* Regular Hosts */}
          {regularHosts.length > 0 && (
            <div className="host-list">
              <div className="host-list-label">
                Other Hosts ({regularHosts.length})
              </div>
              <div className="host-chips">
                {regularHosts.slice(0, 15).map(host => (
                  <span key={host} className="host-chip">{host}</span>
                ))}
                {regularHosts.length > 15 && (
                  <span className="host-more">+{regularHosts.length - 15} more</span>
                )}
              </div>
            </div>
          )}

          {/* Warning for high-impact operations */}
          {needsDoubleConfirm && !confirmed && (
            <div className="multi-host-warning">
              This is a high-impact operation. Click "Proceed" to confirm you understand the risks.
            </div>
          )}

          {confirmed && (
            <div className="multi-host-warning multi-host-warning--error">
              Final confirmation: Are you absolutely sure you want to proceed with this operation on {hosts.length} hosts?
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="multi-host-footer">
          <button className="multi-host-btn multi-host-btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="multi-host-btn multi-host-btn-confirm"
            onClick={handleApprove}
            style={confirmed ? {
              background: 'rgba(255, 48, 48, 0.2)',
              borderColor: 'rgba(255, 48, 48, 0.4)',
              color: '#ff8080'
            } : {}}
          >
            {!needsDoubleConfirm ? 'Approve' : confirmed ? 'Execute Operation' : 'Proceed'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default MultiHostApproval
