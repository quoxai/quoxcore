import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getConfig,
  getChannelStatus,
  isCoreCommsActive,
} from '../../services/coreCommsService'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import './settings.css'

/**
 * CoreCommsSettings — Summary view with link to Communications Command Centre.
 *
 * The full configuration has moved to /comms. This component shows a compact
 * channel status overview and a button to open the Command Centre.
 */
export function CoreCommsSettings() {
  const navigate = useNavigate()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id
  const [isActive, setIsActive] = useState(true)
  const [channelStatus, setChannelStatus] = useState(null)

  useEffect(() => {
    setIsActive(isCoreCommsActive())
    setChannelStatus(getChannelStatus(orgId))
  }, [orgId])

  if (!isActive) {
    return (
      <div className="corecomms-settings">
        <div className="corecomms-promo">
          <div className="corecomms-promo__icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          </div>
          <h3 className="corecomms-promo__title">CoreComms Plugin</h3>
          <p className="corecomms-promo__text">
            Get notified instantly via Telegram, Slack, or Email when HITL items need your attention.
          </p>
          <button className="corecomms-promo__btn" onClick={() => navigate('/settings#plugins', { state: { highlight: 'core-comms' } })}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Get CoreComms - $5
          </button>
        </div>
      </div>
    )
  }

  const renderStatusBadge = (channel) => {
    const status = channelStatus?.[channel]
    if (!status) return null
    if (!status.configured) return <span className="corecomms-badge corecomms-badge--unconfigured">Not Configured</span>
    if (status.failures >= 5) return <span className="corecomms-badge corecomms-badge--disabled">Auto-Disabled</span>
    if (status.testStatus === 'success') return <span className="corecomms-badge corecomms-badge--success">Connected</span>
    if (status.testStatus === 'error') return <span className="corecomms-badge corecomms-badge--error">Failed</span>
    return <span className="corecomms-badge corecomms-badge--untested">Untested</span>
  }

  const channels = [
    { id: 'telegram', name: 'Telegram', icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.198 2.433a2.242 2.242 0 0 0-1.022.215l-8.609 3.33c-2.068.8-4.133 1.598-5.724 2.21a405 405 0 0 0-2.849 1.09c-.42.174-.898.464-.936 1.078-.033.546.378.904.727 1.073.707.343 1.468.574 2.2.818.764.254 1.382.816 1.573 1.613.143.595.1 1.216.168 1.824.082.717.206 1.425.373 2.125.093.39.222.757.453 1.079.303.42.798.594 1.168.344.267-.18.532-.414.772-.658l2.89-2.809 3.778 2.79c.252.186.531.412.871.4.426-.016.764-.347.907-.75.248-.7.395-1.453.578-2.175l2.914-13.228c.11-.494.12-1.06-.198-1.49a1.53 1.53 0 0 0-1.03-.674z"/>
      </svg>
    )},
    { id: 'slack', name: 'Slack', icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1" y="14" width="5" height="5" rx="1"/><rect x="9" y="1" width="5" height="5" rx="1"/><rect x="9" y="14" width="5" height="5" rx="1"/><rect x="17" y="9" width="5" height="5" rx="1"/><path d="M6 16.5h3M14 16.5h3M11.5 6v8M17 11.5h-3"/>
      </svg>
    )},
    { id: 'email', name: 'Email', icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>
      </svg>
    )},
  ]

  return (
    <div className="corecomms-settings">
      <div className="corecomms-header">
        <div className="corecomms-header__info">
          <h3 className="corecomms-header__title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            Notification Channels
          </h3>
          <p className="corecomms-header__subtitle">
            Manage channels, routing rules, and delivery tracking
          </p>
        </div>
      </div>

      {/* Channel summary */}
      {channels.map(ch => (
        <div key={ch.id} className="corecomms-channel" style={{ cursor: 'default' }}>
          <div className="corecomms-channel__header" style={{ cursor: 'default' }}>
            <div className="corecomms-channel__info">
              <span className="corecomms-channel__icon" style={{ width: 20, height: 20 }}>{ch.icon}</span>
              <div className="corecomms-channel__text">
                <span className="corecomms-channel__name">{ch.name}</span>
              </div>
            </div>
            <div className="corecomms-channel__status">
              {renderStatusBadge(ch.id)}
            </div>
          </div>
        </div>
      ))}

      {/* Link to Command Centre */}
      <button
        className="corecomms-btn corecomms-btn--primary"
        onClick={() => navigate('/comms')}
        style={{ marginTop: 16, width: '100%', justifyContent: 'center', padding: '10px 16px' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
        </svg>
        Open Communications Command Centre
      </button>
    </div>
  )
}

export default CoreCommsSettings
