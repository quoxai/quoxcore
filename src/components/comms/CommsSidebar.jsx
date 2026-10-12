/**
 * CommsSidebar — Internal navigation sidebar for Communications Command Centre.
 * Follows InboxFolderSidebar pattern: 240px, grouped items, active indicator, badges.
 */

import { useCallback } from 'react'
import './comms-layout.css'

// Section definitions
const COMMS_SECTIONS = [
  {
    group: 'channels',
    label: 'Channels',
    items: [
      { id: 'overview', label: 'Overview', icon: 'grid' },
      { id: 'telegram', label: 'Telegram', icon: 'telegram', channel: true },
      { id: 'slack', label: 'Slack', icon: 'slack', channel: true },
      { id: 'discord', label: 'Discord', icon: 'discord', channel: true },
      { id: 'email', label: 'Email', icon: 'email', channel: true },
      { id: 'msteams', label: 'MS Teams', icon: 'msteams', channel: true },
      { id: 'twilio-sms', label: 'SMS (Twilio)', icon: 'sms', channel: true },
      { id: 'pagerduty', label: 'PagerDuty', icon: 'pagerduty', channel: true },
      { id: 'opsgenie', label: 'OpsGenie', icon: 'opsgenie', channel: true },
      { id: 'mattermost', label: 'Mattermost', icon: 'mattermost', channel: true },
      { id: 'ntfy', label: 'ntfy', icon: 'ntfy', channel: true },
      { id: 'pushover', label: 'Pushover', icon: 'pushover', channel: true },
      { id: 'google-chat', label: 'Google Chat', icon: 'googlechat', channel: true },
      { id: 'gotify', label: 'Gotify', icon: 'gotify', channel: true },
      { id: 'rocketchat', label: 'Rocket.Chat', icon: 'rocketchat', channel: true },
      { id: 'line', label: 'LINE', icon: 'line', channel: true },
      { id: 'webhook', label: 'Webhook', icon: 'webhook', channel: true },
    ]
  },
  {
    group: 'routing',
    label: 'Routing',
    items: [
      { id: 'rules', label: 'Rules', icon: 'routing' },
    ]
  },
  {
    group: 'activity',
    label: 'Activity',
    items: [
      { id: 'delivery-log', label: 'Delivery Log', icon: 'log' },
    ]
  },
  {
    group: 'scopes',
    label: 'Scopes',
    items: [
      { id: 'assignments', label: 'Assignments', icon: 'matrix' },
    ]
  },
  {
    group: 'insights',
    label: 'Insights',
    items: [
      { id: 'analytics', label: 'Analytics', icon: 'chart' },
    ]
  }
]

export { COMMS_SECTIONS }

// Icons (16px inline SVGs, consistent with InboxFolderSidebar)
const sectionIcons = {
  grid: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  ),
  telegram: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
    </svg>
  ),
  slack: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
    </svg>
  ),
  discord: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
    </svg>
  ),
  email: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>
    </svg>
  ),
  routing: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>
    </svg>
  ),
  log: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
    </svg>
  ),
  msteams: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
      <path d="M19.35 8.03h-.76c.49-.58.76-1.31.76-2.08C19.35 3.72 17.63 2 15.4 2c-1.87 0-3.43 1.27-3.88 3h-1.04c-.28 0-.53.11-.71.29l-.01.01c-.18.19-.29.44-.29.72v5.43c0 .56.46 1.01 1.02 1.01h4.87c.28 0 .53-.11.71-.29.18-.18.3-.44.3-.72V9.03h.98c1.38 0 2.5-1.12 2.5-2.5s-1.12-2.5-2.5-2.5zM20 14h-7c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h7c1.1 0 2-.9 2-2v-4c0-1.1-.9-2-2-2z"/>
    </svg>
  ),
  sms: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      <path d="M8 10h.01M12 10h.01M16 10h.01"/>
    </svg>
  ),
  pagerduty: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--text-primary, #e8eaed)' }}>
      <path d="M16.965 1.18C15.085.164 13.769 0 10.683 0H3.73v14.55h6.926c2.743 0 4.8-.164 6.61-1.37 1.975-1.303 3.004-3.57 3.004-6.238 0-2.86-1.207-4.822-3.305-5.762zM11.357 10.7H7.663V3.814h3.36c3.15 0 4.94 1.26 4.94 3.36 0 2.27-1.71 3.526-4.606 3.526zM3.73 17.616h3.933V24H3.73z"/>
    </svg>
  ),
  opsgenie: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
    </svg>
  ),
  mattermost: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
  ),
  ntfy: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="12" y1="2" x2="12" y2="4"/>
    </svg>
  ),
  pushover: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>
    </svg>
  ),
  googlechat: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  ),
  gotify: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
    </svg>
  ),
  rocketchat: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20l-3 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7z"/>
      <path d="M8 11l3-3 3 3"/>
    </svg>
  ),
  line: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
  ),
  webhook: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  ),
  matrix: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  ),
  chart: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  ),
}

export default function CommsSidebar({ activeSection, onSectionChange, channelStatus = {} }) {
  const handleClick = useCallback((sectionId) => {
    onSectionChange(sectionId)
  }, [onSectionChange])

  // Determine channel dot status
  const getChannelDot = (channelId) => {
    const status = channelStatus[channelId]
    if (!status) return null
    if (status.failures >= 5) return 'error'
    if (status.enabled && status.configured) return 'active'
    return 'inactive'
  }

  return (
    <nav className="comms-sidebar" role="navigation" aria-label="Communications sections">
      {COMMS_SECTIONS.map(group => (
        <div key={group.group} className="comms-sidebar__group">
          <div className="comms-sidebar__group-label">{group.label}</div>
          {group.items.map(item => {
            const isActive = activeSection === item.id
            const dotStatus = item.channel ? getChannelDot(item.id) : null
            const icon = sectionIcons[item.icon]

            return (
              <button
                key={item.id}
                className={`comms-sidebar__item${isActive ? ' comms-sidebar__item--active' : ''}`}
                onClick={() => handleClick(item.id)}
                aria-current={isActive ? 'true' : undefined}
              >
                <span className="comms-sidebar__icon">{icon}</span>
                <span className="comms-sidebar__label">{item.label}</span>
                {dotStatus && (
                  <span className={`comms-sidebar__dot comms-sidebar__dot--${dotStatus}`} />
                )}
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
