/**
 * SystemHealthBadge — Dynamic health status for AppShell header
 *
 * Replaces the hardcoded "All Systems Operational" with a live badge
 * that reflects actual service health. Clicking opens a dropdown
 * listing affected services.
 */

import { useState, useRef, useEffect } from 'react'
import { useHealth } from '../../contexts/HealthContext'

function SystemHealthBadge() {
  const { overallStatus, degradedCount, downCount, services, loading } = useHealth()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const badgeRef = useRef(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return
    function handleClick(e) {
      if (badgeRef.current && !badgeRef.current.contains(e.target)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [dropdownOpen])

  // Derive display state
  let dotClass = 'status-dot--online'
  let label = 'Services'

  if (loading) {
    dotClass = 'status-dot--loading'
    label = 'Checking...'
  } else if (overallStatus === 'unreachable') {
    // Three or more services unreachable at once is usually this browser's own
    // connection, so naming three separate outages would be alarmist. Claiming
    // everything is fine, which is what this used to do, is worse. Say what is
    // actually known: we cannot reach the platform to ask.
    dotClass = 'status-dot--degraded'
    label = 'Platform unreachable'
  } else if (downCount > 0) {
    dotClass = 'status-dot--offline'
    label = `${downCount} Service${downCount > 1 ? 's' : ''} Down`
  } else if (degradedCount > 0) {
    dotClass = 'status-dot--degraded'
    label = `${degradedCount} Service${degradedCount > 1 ? 's' : ''} Degraded`
  }

  // Collect affected services for dropdown
  const affected = []
  if (!loading && services) {
    for (const [key, svc] of Object.entries(services)) {
      // First failed sweep is not confirmed yet (debounce): not flagged.
      if (svc._awaitingConfirmation) continue
      if (!svc.responding) {
        affected.push({ key, name: svc.name || key, status: 'down' })
      } else if (!svc.healthy) {
        affected.push({ key, name: svc.name || key, status: 'degraded' })
      }
    }
  }

  const hasIssues = affected.length > 0

  return (
    <span
      className="app-shell__status-badge"
      ref={badgeRef}
      onClick={hasIssues ? () => setDropdownOpen(!dropdownOpen) : undefined}
      style={hasIssues ? { cursor: 'pointer' } : undefined}
    >
      <span className={`status-dot ${dotClass}`}></span>
      {label}
      {hasIssues && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          style={{ width: 12, height: 12, marginLeft: 4, opacity: 0.6 }}>
          <polyline points={dropdownOpen ? "18 15 12 9 6 15" : "6 9 12 15 18 9"} />
        </svg>
      )}
      {dropdownOpen && affected.length > 0 && (
        <div className="health-badge-dropdown">
          <div className="health-badge-dropdown__title">Affected Services</div>
          {affected.map(svc => (
            <div key={svc.key} className="health-badge-dropdown__item">
              <span className={`status-dot status-dot--${svc.status === 'down' ? 'offline' : 'degraded'}`}></span>
              <span className="health-badge-dropdown__name">{svc.name}</span>
              <span className={`health-badge-dropdown__status health-badge-dropdown__status--${svc.status}`}>
                {svc.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </span>
  )
}

export default SystemHealthBadge
