/**
 * AccountHealthPanel — TikTok's own vaulted credential status, connected
 * profile, and the 24h access-token countdown. TT-4, mirrors
 * src/components/instagram/AccountHealthPanel.jsx.
 *
 * TikTok is NOT on a shared credential: it has its own dedicated 'tiktok'
 * vault entry, and that access_token lives exactly 24 hours with no
 * auto-refresh built yet, so the countdown here is hours, not days, and
 * turns amber under 12h and red under 4h.
 */

import './tiktok.css'

export default function AccountHealthPanel({ credentialHealth, profile, tokenExpiry, onRefresh }) {
  const connected = credentialHealth?.connected
  const reason = credentialHealth?.reason
  const statusColor = connected ? 'rgba(52, 211, 153, 0.9)' : 'rgba(248, 113, 113, 0.9)'
  const statusText = connected ? 'Connected' : 'Not Connected'

  const displayName = profile?.display_name || null
  const followers = profile?.followers ?? null

  const hoursLeft = tokenExpiry?.hoursLeft
  const expiryColor = hoursLeft == null ? 'rgba(255,255,255,0.85)'
    : hoursLeft <= 4 ? 'rgba(248, 113, 113, 0.9)'
    : hoursLeft <= 12 ? 'rgba(251, 191, 36, 0.9)'
    : 'rgba(52, 211, 153, 0.9)'
  const expiryText = tokenExpiry
    ? (hoursLeft <= 0
        ? 'Expired'
        : `${hoursLeft} hour${hoursLeft === 1 ? '' : 's'} left`)
    : null

  return (
    <div className="tt-panel">
      <div className="tt-panel__header">
        <h3 className="tt-panel__title">
          <svg viewBox="0 0 24 24" fill="none" style={{ width: 16, height: 16, flexShrink: 0 }}>
            <path d="M16 3v9.5a4 4 0 1 1-4-4V3" stroke="rgba(254, 44, 85, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M16 3a5 5 0 0 0 5 5" stroke="rgba(37, 244, 238, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Account Health
        </h3>
        {onRefresh && (
          <button className="tt-panel__action" onClick={onRefresh} title="Refresh">
            &#8635;
          </button>
        )}
      </div>
      <div className="tt-panel__body">
        <div className="tt-health-grid">
          <div className="tt-health-item">
            <span className="tt-health-label">Status</span>
            <span className="tt-health-value" style={{ color: statusColor }}>
              <span className="tt-health-dot" style={{ background: statusColor }} />
              {statusText}
            </span>
          </div>

          <div className="tt-health-item">
            <span className="tt-health-label">Credential</span>
            <span className="tt-health-value">TikTok's own vaulted access token (24h lifetime)</span>
          </div>

          {expiryText && (
            <div className="tt-health-item">
              <span className="tt-health-label">Token Expires</span>
              <span className="tt-health-value" style={{ color: expiryColor }}>{expiryText}</span>
            </div>
          )}

          <div className="tt-health-item">
            <span className="tt-health-label">Auto-refresh</span>
            <span className="tt-health-value">Not built yet, rotate the access_token manually</span>
          </div>

          {credentialHealth?.error && (
            <div className="tt-health-item">
              <span className="tt-health-label">Error</span>
              <span className="tt-health-value tt-health-value--error">{credentialHealth.error}</span>
            </div>
          )}

          {displayName && (
            <div className="tt-health-item">
              <span className="tt-health-label">Account</span>
              <span className="tt-health-value">{displayName}</span>
            </div>
          )}

          {followers != null && (
            <div className="tt-health-item">
              <span className="tt-health-label">Followers</span>
              <span className="tt-health-value">{followers.toLocaleString()}</span>
            </div>
          )}

          {!connected && reason !== 'no_credential' && (
            <div className="tt-health-cta">
              <p style={{ color: 'rgba(255,255,255,0.7)', margin: 0, fontSize: '13px' }}>
                TikTok access tokens live 24 hours with no auto-refresh yet, so this is most
                likely a normal expiry, not a broken credential. Rotate the access_token in
                the Vault.
              </p>
            </div>
          )}

          {!connected && reason === 'no_credential' && (
            <div className="tt-health-cta">
              <p style={{ color: 'rgba(255,255,255,0.7)', margin: 0, fontSize: '13px' }}>
                Add your TikTok access_token, refresh_token, client_key, and client_secret in
                the Vault to connect.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
