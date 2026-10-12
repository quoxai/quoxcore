/**
 * AccountHealthPanel — shared Meta credential status, linked Facebook Page,
 * and the resolved Instagram professional account. IG-3, mirrors
 * src/components/facebook/AccountHealthPanel.jsx.
 *
 * Instagram is its own plugin on the SAME shared 'meta' vault credential
 * the facebook plugin uses — this panel states that plainly rather than
 * implying a second, separate connection.
 */

import './instagram.css'

export default function AccountHealthPanel({ credentialHealth, account, tokenExpiry, onRefresh }) {
  const connected = credentialHealth?.connected
  const reason = credentialHealth?.reason
  const statusColor = connected ? 'rgba(52, 211, 153, 0.9)' : 'rgba(248, 113, 113, 0.9)'
  const statusText = connected ? 'Connected' : (reason === 'no_ig_linked' ? 'Page connected, no Instagram linked' : 'Not Connected')

  const linkedAccount = credentialHealth?.account || null
  const igUserId = linkedAccount?.ig_user_id || account?.id || null
  const username = linkedAccount?.username || account?.username || null
  const linkedPage = linkedAccount?.linked_page || null

  // Same 60-day Meta long-lived token lifetime as the facebook plugin.
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
    <div className="ig-panel">
      <div className="ig-panel__header">
        <h3 className="ig-panel__title">
          <svg viewBox="0 0 24 24" fill="none" style={{ width: 16, height: 16, flexShrink: 0 }}>
            <rect x="3" y="3" width="18" height="18" rx="5" stroke="rgba(228, 64, 95, 0.9)" strokeWidth="1.8"/>
            <circle cx="12" cy="12" r="4" stroke="rgba(228, 64, 95, 0.9)" strokeWidth="1.8"/>
            <circle cx="17.5" cy="6.5" r="1.2" fill="rgba(228, 64, 95, 0.9)"/>
          </svg>
          Account Health
        </h3>
        {onRefresh && (
          <button className="ig-panel__action" onClick={onRefresh} title="Refresh">
            &#8635;
          </button>
        )}
      </div>
      <div className="ig-panel__body">
        <div className="ig-health-grid">
          <div className="ig-health-item">
            <span className="ig-health-label">Status</span>
            <span className="ig-health-value" style={{ color: statusColor }}>
              <span className="ig-health-dot" style={{ background: statusColor }} />
              {statusText}
            </span>
          </div>

          <div className="ig-health-item">
            <span className="ig-health-label">Credential</span>
            <span className="ig-health-value">Shared with Facebook (same vaulted Meta token)</span>
          </div>

          {expiryText && (
            <div className="ig-health-item">
              <span className="ig-health-label">Token Expires</span>
              <span className="ig-health-value" style={{ color: expiryColor }}>{expiryText}</span>
            </div>
          )}

          {credentialHealth?.error && (
            <div className="ig-health-item">
              <span className="ig-health-label">{reason === 'no_ig_linked' ? 'Linkage' : 'Error'}</span>
              <span className="ig-health-value ig-health-value--error">{credentialHealth.error}</span>
            </div>
          )}

          {linkedPage && (
            <div className="ig-health-item">
              <span className="ig-health-label">Linked Page</span>
              <span className="ig-health-value">{linkedPage.name || linkedPage.id}</span>
            </div>
          )}

          {igUserId && (
            <div className="ig-health-item">
              <span className="ig-health-label">Instagram Account</span>
              <span className="ig-health-value">{username ? `@${username}` : igUserId}</span>
            </div>
          )}

          {account?.followers != null && (
            <div className="ig-health-item">
              <span className="ig-health-label">Followers</span>
              <span className="ig-health-value">{account.followers.toLocaleString()}</span>
            </div>
          )}

          {!connected && (
            <div className="ig-health-cta">
              <p style={{ color: 'rgba(255,255,255,0.7)', margin: 0, fontSize: '13px' }}>
                {reason === 'no_ig_linked'
                  ? 'Your Facebook Page token works, but no Instagram professional account is linked to it. Link one in Meta Business Suite, then re-run discovery.'
                  : 'Add your Meta (Facebook Page) access token in the Vault to connect, the same credential the Facebook plugin uses.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
