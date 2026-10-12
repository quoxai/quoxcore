/**
 * CommsLayout — Main layout for Communications Command Centre.
 * Stats strip + sidebar + content area, following the InboxView pattern.
 */

import { useState, useCallback } from 'react'
import CommsSidebar from './CommsSidebar'
import CommsOverview from './CommsOverview'
import ChannelConfigPanel from './ChannelConfigPanel'
import './comms-layout.css'

export default function CommsLayout({
  config,
  channelStatus,
  deliveryStats,
  recentDeliveries,
  webhookInfo,
  slackWebhookInfo,
  telegramBots,
  discordWebhookInfo,
  webhookEndpoints,
  orgName,
  // Actions
  onUpdate,
  onUpdateSmtp,
  onTogglePriority,
  onSave,
  onTest,
  onRegisterWebhook,
  onDeactivateWebhook,
  onRegisterSlackWebhook,
  onDeactivateSlackWebhook,
  onRegisterDiscordWebhook,
  onDeactivateDiscordWebhook,
  // Routing rules panel
  routingRulesPanel,
  // Delivery log panel
  deliveryLogPanel,
  // Phase D5 panels
  assignmentsPanel,
  analyticsPanel,
  // Test state
  testing,
  testResult,
}) {
  const [activeSection, setActiveSection] = useState('overview')

  const handleSectionChange = useCallback((section) => {
    setActiveSection(section)
  }, [])

  const handleSelectChannel = useCallback((channelType) => {
    setActiveSection(channelType)
  }, [])

  const handleBack = useCallback(() => {
    setActiveSection('overview')
  }, [])

  // Calculate delivery rate
  const rate = deliveryStats.total > 0
    ? Math.round((deliveryStats.sent / deliveryStats.total) * 100)
    : null

  const renderContent = () => {
    switch (activeSection) {
      case 'overview':
        return (
          <CommsOverview
            config={config}
            channelStatus={channelStatus}
            deliveryStats={deliveryStats}
            recentDeliveries={recentDeliveries}
            onSelectChannel={handleSelectChannel}
          />
        )

      case 'telegram':
      case 'slack':
      case 'discord':
      case 'email':
      case 'msteams':
      case 'twilio-sms':
      case 'pagerduty':
      case 'opsgenie':
      case 'mattermost':
      case 'ntfy':
      case 'pushover':
      case 'google-chat':
      case 'gotify':
      case 'rocketchat':
      case 'line':
      case 'webhook':
        return (
          <ChannelConfigPanel
            channelType={activeSection}
            config={config}
            webhookInfo={activeSection === 'telegram' ? webhookInfo : null}
            slackWebhookInfo={activeSection === 'slack' ? slackWebhookInfo : null}
            telegramBots={activeSection === 'telegram' ? telegramBots : null}
            discordWebhookInfo={activeSection === 'discord' ? discordWebhookInfo : null}
            webhookEndpoints={activeSection === 'webhook' ? webhookEndpoints : null}
            onUpdate={onUpdate}
            onUpdateSmtp={onUpdateSmtp}
            onTogglePriority={onTogglePriority}
            onTest={onTest}
            onSave={onSave}
            onRegisterWebhook={onRegisterWebhook}
            onDeactivateWebhook={onDeactivateWebhook}
            onRegisterSlackWebhook={onRegisterSlackWebhook}
            onDeactivateSlackWebhook={onDeactivateSlackWebhook}
            onRegisterDiscordWebhook={onRegisterDiscordWebhook}
            onDeactivateDiscordWebhook={onDeactivateDiscordWebhook}
            onBack={handleBack}
            testing={testing}
            testResult={testResult}
            orgName={orgName}
          />
        )

      case 'rules':
        return routingRulesPanel || (
          <div className="comms-empty">
            <div className="comms-empty__icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
                <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
                <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
                <line x1="4" y1="4" x2="9" y2="9"/>
              </svg>
            </div>
            <p>Routing rules determine which users receive notifications based on event type, priority, and tags.</p>
          </div>
        )

      case 'delivery-log':
        return deliveryLogPanel || (
          <div className="comms-empty">
            <div className="comms-empty__icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <p>Delivery log tracks every notification sent, with status and retry capability.</p>
          </div>
        )

      case 'assignments':
        return assignmentsPanel || (
          <div className="comms-empty">
            <div className="comms-empty__icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
            </div>
            <p>Assign notification channels to scopes to control which teams receive which notifications.</p>
          </div>
        )

      case 'analytics':
        return analyticsPanel || (
          <div className="comms-empty">
            <div className="comms-empty__icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
                <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
                <line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
            </div>
            <p>Delivery analytics show notification volume, success rates, and trends over time.</p>
          </div>
        )

      default:
        return (
          <CommsOverview
            config={config}
            channelStatus={channelStatus}
            deliveryStats={deliveryStats}
            recentDeliveries={recentDeliveries}
            onSelectChannel={handleSelectChannel}
          />
        )
    }
  }

  return (
    <div className="comms-layout">
      {/* Stats strip */}
      <div className="comms-stats-strip">
        <div className="comms-stat">
          <span className="comms-stat__value comms-stat__value--success">{deliveryStats.sent}</span>
          <span className="comms-stat__label">Sent</span>
        </div>
        <div className="comms-stat__divider" />
        <div className="comms-stat">
          <span className="comms-stat__value comms-stat__value--error">{deliveryStats.failed}</span>
          <span className="comms-stat__label">Failed</span>
        </div>
        <div className="comms-stat__divider" />
        <div className="comms-stat">
          <span className={`comms-stat__value ${rate !== null && rate >= 90 ? 'comms-stat__value--success' : rate !== null && rate < 50 ? 'comms-stat__value--error' : 'comms-stat__value--neutral'}`}>
            {rate !== null ? `${rate}%` : '—'}
          </span>
          <span className="comms-stat__label">Delivery Rate</span>
        </div>
      </div>

      {/* Body: sidebar + content */}
      <div className="comms-body">
        <CommsSidebar
          activeSection={activeSection}
          onSectionChange={handleSectionChange}
          channelStatus={channelStatus}
        />
        <div className="comms-content">
          {renderContent()}
        </div>
      </div>
    </div>
  )
}
