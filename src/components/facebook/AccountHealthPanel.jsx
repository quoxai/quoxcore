/**
 * AccountHealthPanel — vault credential status and connected Page info.
 * FB-3, mirrors src/components/linkedin/AccountHealthPanel.jsx.
 */

import './facebook.css'

export default function AccountHealthPanel({ credentialHealth, pageInfo, tokenExpiry, onRefresh }) {
  const connected = credentialHealth?.connected
  const statusColor = connected ? 'rgba(52, 211, 153, 0.9)' : 'rgba(248, 113, 113, 0.9)'
  const statusText = connected ? 'Connected' : 'Not Connected'

  // Meta long-lived tokens live 60 days with no refresh; surface the
  // vault-stamped expiry so the wizard's guidance holds true. Amber inside
  // 14 days, red inside 7.
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
    <div className="fb-panel">
      <div className="fb-panel__header">
        <h3 className="fb-panel__title">
          <svg viewBox="0 0 24 24" fill="none" style={{ width: 16, height: 16, flexShrink: 0 }}>
            <path d="M15 4h-2a5 5 0 0 0-5 5v3H6v4h2v8h4v-8h3l1-4h-4V9a1 1 0 0 1 1-1h3z" stroke="rgba(24, 119, 242, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Account Health
        </h3>
        {onRefresh && (
          <button className="fb-panel__action" onClick={onRefresh} title="Refresh">
            &#8635;
          </button>
        )}
      </div>
      <div className="fb-panel__body">
        <div className="fb-health-grid">
          <div className="fb-health-item">
            <span className="fb-health-label">Status</span>
            <span className="fb-health-value" style={{ color: statusColor }}>
              <span className="fb-health-dot" style={{ background: statusColor }} />
              {statusText}
            </span>
          </div>

          {expiryText && (
            <div className="fb-health-item">
              <span className="fb-health-label">Token Expires</span>
              <span className="fb-health-value" style={{ color: expiryColor }}>{expiryText}</span>
            </div>
          )}

          {credentialHealth?.error && (
            <div className="fb-health-item">
              <span className="fb-health-label">Error</span>
              <span className="fb-health-value fb-health-value--error">{credentialHealth.error}</span>
            </div>
          )}

          {pageInfo && (
            <>
              <div className="fb-health-item">
                <span className="fb-health-label">Page</span>
                <span className="fb-health-value">{pageInfo.name || 'Unknown'}</span>
              </div>
              <div className="fb-health-item">
                <span className="fb-health-label">Category</span>
                <span className="fb-health-value">{pageInfo.category || 'Unknown'}</span>
              </div>
              <div className="fb-health-item">
                <span className="fb-health-label">Followers</span>
                <span className="fb-health-value">{(pageInfo.followers || 0).toLocaleString()}</span>
              </div>
              {pageInfo.link && (
                <div className="fb-health-item">
                  <span className="fb-health-label">Page link</span>
                  <span className="fb-health-value">{pageInfo.link}</span>
                </div>
              )}
            </>
          )}

          {!connected && (
            <div className="fb-health-cta">
              <p style={{ color: 'rgba(255,255,255,0.7)', margin: 0, fontSize: '13px' }}>
                Add your Facebook Page access token in the Vault to connect.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
