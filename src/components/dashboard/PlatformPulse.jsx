/**
 * PlatformPulse — Aggregate health widget
 *
 * Replaces QuickStatsStrip with a richer view powered by the
 * /api/v1/health/aggregate endpoint. Shows services, fleet,
 * sessions, vault, memory, AEE in one compact strip.
 *
 * CLI-3.5B1 (Stream CLI Phase 3.5)
 */

import { useMemo } from 'react'
import './PlatformPulse.css'

const STATUS_DOT = {
  ok: 'pulse-service--ok',
  degraded: 'pulse-service--degraded',
  down: 'pulse-service--down',
}

export default function PlatformPulse({ data, error }) {
  if (error) {
    return (
      <div className="platform-pulse platform-pulse--error">
        <span className="pulse-error-icon">⚠</span>
        <span className="pulse-error-text">{error}</span>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="platform-pulse platform-pulse--loading">
        <span className="pulse-loading-text">Loading platform status...</span>
      </div>
    )
  }

  const scoreClass = data.score >= 90 ? 'pulse-score--good'
    : data.score >= 70 ? 'pulse-score--warn'
    : 'pulse-score--critical'

  return (
    <div className="platform-pulse">
      {/* Health Score */}
      <div className={`pulse-section pulse-score ${scoreClass}`}>
        <span className="pulse-score-value">{data.score}%</span>
        <span className="pulse-score-label">Health</span>
      </div>

      {/* Services */}
      <div className="pulse-section pulse-services">
        {Object.entries(data.services || {}).map(([name, svc]) => (
          <span
            key={name}
            className={`pulse-service ${STATUS_DOT[svc.status] || 'pulse-service--unknown'}`}
            title={`${name}: ${svc.status} (${svc.latency_ms ?? '?'}ms)`}
          >
            <span className="pulse-service-dot">●</span>
            <span className="pulse-service-name">{name}</span>
          </span>
        ))}
      </div>

      {/* Fleet */}
      <div className="pulse-section pulse-fleet">
        <span className="pulse-fleet-total">{data.fleet?.total || 0}</span>
        <span className="pulse-fleet-label">fleet</span>
        {data.fleet?.down > 0 && (
          <span className="pulse-fleet-down">{data.fleet.down} down</span>
        )}
      </div>

      {/* Sessions */}
      <div className="pulse-section pulse-sessions">
        <span className="pulse-sessions-count">{data.sessions?.active || 0}</span>
        <span className="pulse-sessions-label">sessions</span>
        {data.sessions?.cost_today_usd > 0 && (
          <span className="pulse-sessions-cost">${data.sessions.cost_today_usd.toFixed(2)}</span>
        )}
      </div>

      {/* AEE */}
      {data.aee?.envelopes_today > 0 && (
        <div className="pulse-section pulse-aee">
          <span className="pulse-aee-count">
            {data.aee.envelopes_today.toLocaleString()}
          </span>
          <span className="pulse-aee-label">AEE</span>
          <span className={`pulse-aee-integrity ${data.aee.chain_ok ? 'pulse-aee--ok' : 'pulse-aee--broken'}`}>
            {data.aee.chain_ok ? '✓' : '✗'}
          </span>
        </div>
      )}

      {/* Vault warnings */}
      {data.vault?.expiring_soon > 0 && (
        <div className="pulse-section pulse-vault-warn">
          <span className="pulse-vault-icon">⚠</span>
          <span className="pulse-vault-text">{data.vault.expiring_soon} creds expiring</span>
        </div>
      )}
    </div>
  )
}
