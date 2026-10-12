/**
 * AccountHealthPanel — vault credential status and connected account info.
 */

import { useState, useEffect } from 'react'
import './linkedin.css'

export default function AccountHealthPanel({ credentialHealth, orgInfo, tokenExpiry, onRefresh }) {
  const connected = credentialHealth?.connected
  const statusColor = connected ? 'rgba(52, 211, 153, 0.9)' : 'rgba(248, 113, 113, 0.9)'
  const statusText = connected ? 'Connected' : 'Not Connected'

  // LI-OVERHAUL P5: LinkedIn tokens live 60 days with no refresh for
  // standard apps; surface the vault-stamped expiry so the wizard's
  // "the dashboard will warn you" line is true. Amber inside 14 days,
  // red inside 7 (the inbox warning fires at 7 too).
  const daysLeft = tokenExpiry?.daysLeft
  const expiryColor = daysLeft == null ? 'rgba(255,255,255,0.85)'
    : daysLeft <= 7 ? 'rgba(248, 113, 113, 0.9)'
    : daysLeft <= 14 ? 'rgba(251, 191, 36, 0.9)'
    : 'rgba(52, 211, 153, 0.9)'
  const expiryText = tokenExpiry
    ? (daysLeft <= 0
        ? 'Expired'
        : `${new Date(tokenExpiry.expiresAt).toLocaleDateString()} (${daysLeft} day${daysLeft === 1 ? '' : 's'})`)
    : null

  return (
    <div className="li-panel">
      <div className="li-panel__header">
        <h3 className="li-panel__title">
          <svg viewBox="0 0 24 24" fill="none" style={{ width: 16, height: 16, flexShrink: 0 }}>
            <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" stroke="rgba(10, 102, 194, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            <rect x="2" y="9" width="4" height="12" stroke="rgba(10, 102, 194, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="4" cy="4" r="2" stroke="rgba(10, 102, 194, 0.9)" strokeWidth="1.8"/>
          </svg>
          Account Health
        </h3>
        {onRefresh && (
          <button className="li-panel__action" onClick={onRefresh} title="Refresh">
            &#8635;
          </button>
        )}
      </div>
      <div className="li-panel__body">
        <div className="li-health-grid">
          <div className="li-health-item">
            <span className="li-health-label">Status</span>
            <span className="li-health-value" style={{ color: statusColor }}>
              <span className="li-health-dot" style={{ background: statusColor }} />
              {statusText}
            </span>
          </div>

          {expiryText && (
            <div className="li-health-item">
              <span className="li-health-label">Token Expires</span>
              <span className="li-health-value" style={{ color: expiryColor }}>{expiryText}</span>
            </div>
          )}

          {credentialHealth?.error && (
            <div className="li-health-item">
              <span className="li-health-label">Error</span>
              <span className="li-health-value li-health-value--error">{credentialHealth.error}</span>
            </div>
          )}

          {orgInfo && (
            <>
              <div className="li-health-item">
                <span className="li-health-label">Organisation</span>
                <span className="li-health-value">{orgInfo.name || 'Unknown'}</span>
              </div>
              <div className="li-health-item">
                <span className="li-health-label">Followers</span>
                <span className="li-health-value">{(orgInfo.followers || 0).toLocaleString()}</span>
              </div>
              {orgInfo.website && (
                <div className="li-health-item">
                  <span className="li-health-label">Website</span>
                  <span className="li-health-value">{orgInfo.website}</span>
                </div>
              )}
            </>
          )}

          {!connected && (
            <div className="li-health-cta">
              <p style={{ color: 'rgba(255,255,255,0.7)', margin: 0, fontSize: '13px' }}>
                Add your LinkedIn OAuth access token in the Vault to connect.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
