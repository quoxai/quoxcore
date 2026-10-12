import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { isCoreCommsActive } from '../../services/coreCommsService'
import './inbox.css'

const DISMISS_KEY = 'quox_corecomms_banner_dismissed'

/**
 * CoreCommsBanner - Promotes CoreComms plugin installation in HITL inbox
 * Shows when plugin is not installed/activated. Dismissible.
 */
export function CoreCommsBanner() {
  const navigate = useNavigate()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Only show if plugin not active AND not dismissed
    const dismissed = localStorage.getItem(DISMISS_KEY)
    const active = isCoreCommsActive()
    setVisible(!active && !dismissed)
  }, [])

  const handleDismiss = (e) => {
    e.stopPropagation()
    localStorage.setItem(DISMISS_KEY, 'true')
    setVisible(false)
  }

  const handleActivate = () => {
    navigate('/settings#plugins')
  }

  if (!visible) return null

  return (
    <div className="qx-banner qx-banner--info corecomms-banner" role="note" onClick={handleActivate}>
      <svg className="qx-banner__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        <line x1="12" y1="2" x2="12" y2="4" />
      </svg>
      <span>
        <span className="qx-banner__title">Never miss a critical alert</span>
        Get notified instantly via Telegram, Slack, or Email when items need your attention.
      </span>
      <span className="qx-banner__actions">
        <button className="qx-btn qx-btn--primary qx-btn--sm" onClick={(e) => { e.stopPropagation(); handleActivate(); }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Set Up CoreComms
        </button>
        <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={handleDismiss} aria-label="Dismiss">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </span>
    </div>
  )
}

export default CoreCommsBanner
