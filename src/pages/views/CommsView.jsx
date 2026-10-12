/**
 * CommsView — Communications Command Centre page wrapper.
 *
 * Dedicated /comms page that replaces the Settings > Notifications subsection
 * with a full command centre: channel management, routing rules, delivery log.
 */

import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCommsData } from '../../hooks/useCommsData'
import CommsLayout from '../../components/comms/CommsLayout'
import RoutingRulesPanel from '../../components/comms/RoutingRulesPanel'
import DeliveryLogPanel from '../../components/comms/DeliveryLogPanel'
import ScopeAssignmentPanel from '../../components/comms/ScopeAssignmentPanel'
import CommsAnalytics from '../../components/comms/CommsAnalytics'

export default function CommsView() {
  const navigate = useNavigate()
  const {
    config,
    channelStatus,
    deliveryStats,
    recentDeliveries,
    loading,
    error,
    isActive,
    webhookInfo,
    orgId,
    currentOrg,
    // Actions
    handleSave,
    handleReset,
    updateChannel,
    updateSmtp,
    togglePriority,
    refresh,
    loadConfig,
    setConfig,
    // Service functions
    testTelegram,
    testSlack,
    testEmail,
    testWebhookChannel,
    registerTelegramWebhook,
    deactivateTelegramWebhook,
    getTelegramWebhookInfo: refreshWebhookInfo,
    setWebhookInfo,
    // Slack inbound
    slackWebhookInfo,
    registerSlackWebhook,
    deactivateSlackWebhook,
    getSlackWebhookInfo: refreshSlackWebhookInfo,
    // Multi-bot Telegram
    telegramBots,
    // Discord inbound
    discordWebhookInfo,
    registerDiscordWebhook,
    deactivateDiscordWebhook,
    getDiscordWebhookInfo: refreshDiscordWebhookInfo,
    // Generic webhook endpoints
    webhookEndpoints
  } = useCommsData()

  const [testing, setTesting] = useState(null)
  const [testResult, setTestResult] = useState(null)
  const [hasChanges, setHasChanges] = useState(false)

  // Track changes
  const handleUpdate = useCallback((channel, updates) => {
    updateChannel(channel, updates)
    setHasChanges(true)
  }, [updateChannel])

  const handleUpdateSmtp = useCallback((field, value) => {
    updateSmtp(field, value)
    setHasChanges(true)
  }, [updateSmtp])

  const handleTogglePriority = useCallback((channel, priority) => {
    togglePriority(channel, priority)
    setHasChanges(true)
  }, [togglePriority])

  const handleSaveConfig = useCallback(() => {
    const ok = handleSave()
    if (ok) {
      setHasChanges(false)
      setTestResult({ success: true, message: 'Settings saved!' })
      const t = setTimeout(() => setTestResult(null), 3000)
      return () => clearTimeout(t)
    } else {
      setTestResult({ success: false, error: 'Failed to save settings' })
    }
  }, [handleSave])

  const handleTest = useCallback(async (channelType) => {
    if (!config) return

    setTesting(channelType)
    setTestResult(null)

    try {
      let result
      const WEBHOOK_CHANNELS = ['discord', 'msteams', 'mattermost', 'google-chat', 'rocketchat', 'ntfy', 'gotify', 'webhook']
      switch (channelType) {
        case 'telegram':
          if (!config.telegram?.botToken || !config.telegram?.chatId) {
            setTestResult({ success: false, error: 'Bot token and chat ID required' })
            setTesting(null)
            return
          }
          result = await testTelegram(config.telegram.botToken, config.telegram.chatId, orgId)
          break
        case 'slack':
          if (!config.slack?.webhookUrl) {
            setTestResult({ success: false, error: 'Webhook URL required' })
            setTesting(null)
            return
          }
          result = await testSlack(config.slack.webhookUrl, orgId)
          break
        case 'email':
          // The transport is resolved server-side from the vault, so a recipient is the
          // only thing this screen needs before it can send a test.
          if (!config.email?.to) {
            setTestResult({ success: false, error: 'Recipient email required' })
            setTesting(null)
            return
          }
          result = await testEmail(null, config.email.to, config.email.from, orgId)
          break
        default:
          if (WEBHOOK_CHANNELS.includes(channelType) && config[channelType]) {
            result = await testWebhookChannel(channelType, config[channelType], orgId)
          } else {
            result = { success: false, error: `Test not available for ${channelType}. Configure via server-side routing.` }
          }
      }

      setTestResult({ channel: channelType, ...result })
      if (result.success) loadConfig()
    } catch (err) {
      setTestResult({ success: false, error: err.message })
    } finally {
      setTesting(null)
    }
  }, [config, orgId, testTelegram, testSlack, testEmail, testWebhookChannel, loadConfig])

  const handleRegisterWebhook = useCallback(async (url) => {
    try {
      const result = await registerTelegramWebhook(url)
      if (result.success) {
        setTestResult({ success: true, message: `Webhook registered. Bot: @${result.bot_username || 'unknown'}` })
        refreshWebhookInfo()
      } else {
        setTestResult({ success: false, error: result.error || 'Registration failed' })
      }
    } catch (err) {
      setTestResult({ success: false, error: err.message })
    }
  }, [registerTelegramWebhook, refreshWebhookInfo])

  const handleDeactivateWebhook = useCallback(async () => {
    try {
      await deactivateTelegramWebhook()
      setTestResult({ success: true, message: 'Webhook deactivated' })
      refreshWebhookInfo()
    } catch (err) {
      setTestResult({ success: false, error: err.message })
    }
  }, [deactivateTelegramWebhook, refreshWebhookInfo])

  const handleRegisterSlackWebhook = useCallback(async (url) => {
    try {
      const result = await registerSlackWebhook(url)
      if (result.success) {
        setTestResult({ success: true, message: `Slack webhook registered. Bot: @${result.bot_username || 'unknown'}` })
        refreshSlackWebhookInfo()
      } else {
        setTestResult({ success: false, error: result.error || 'Registration failed' })
      }
    } catch (err) {
      setTestResult({ success: false, error: err.message })
    }
  }, [registerSlackWebhook, refreshSlackWebhookInfo])

  const handleDeactivateSlackWebhook = useCallback(async () => {
    try {
      await deactivateSlackWebhook()
      setTestResult({ success: true, message: 'Slack webhook deactivated' })
      refreshSlackWebhookInfo()
    } catch (err) {
      setTestResult({ success: false, error: err.message })
    }
  }, [deactivateSlackWebhook, refreshSlackWebhookInfo])

  const handleRegisterDiscordWebhook = useCallback(async (params) => {
    try {
      const result = await registerDiscordWebhook(params)
      if (result.success) {
        setTestResult({ success: true, message: `Discord bot connected. Bot: @${result.bot_username || 'unknown'}` })
        refreshDiscordWebhookInfo()
      } else {
        setTestResult({ success: false, error: result.error || 'Setup failed' })
      }
    } catch (err) {
      setTestResult({ success: false, error: err.message })
    }
  }, [registerDiscordWebhook, refreshDiscordWebhookInfo])

  const handleDeactivateDiscordWebhook = useCallback(async () => {
    try {
      await deactivateDiscordWebhook()
      setTestResult({ success: true, message: 'Discord webhook deactivated' })
      refreshDiscordWebhookInfo()
    } catch (err) {
      setTestResult({ success: false, error: err.message })
    }
  }, [deactivateDiscordWebhook, refreshDiscordWebhookInfo])

  // Plugin not licensed
  if (!isActive) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, padding: 48 }}>
        <div className="corecomms-promo">
          <div className="corecomms-promo__icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
          </div>
          <h3 className="corecomms-promo__title">CoreComms Plugin</h3>
          <p className="corecomms-promo__text">
            Get notified instantly via Telegram, Slack, or Email when HITL items need your attention.
          </p>
          <button className="corecomms-promo__btn" onClick={() => navigate('/settings#plugins', { state: { highlight: 'core-comms' } })}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Get CoreComms - $5
          </button>
        </div>
      </div>
    )
  }

  // Loading
  if (loading || !config) {
    return (
      <div className="comms-loading">
        <svg className="corecomms-spinner" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20"/>
        </svg>
        Loading Communications Centre...
      </div>
    )
  }

  return (
    <CommsLayout
      config={config}
      channelStatus={channelStatus}
      deliveryStats={deliveryStats}
      recentDeliveries={recentDeliveries}
      webhookInfo={webhookInfo}
      slackWebhookInfo={slackWebhookInfo}
      telegramBots={telegramBots}
      discordWebhookInfo={discordWebhookInfo}
      webhookEndpoints={webhookEndpoints}
      orgName={currentOrg?.name}
      onUpdate={handleUpdate}
      onUpdateSmtp={handleUpdateSmtp}
      onTogglePriority={handleTogglePriority}
      onSave={handleSaveConfig}
      onTest={handleTest}
      onRegisterWebhook={handleRegisterWebhook}
      onDeactivateWebhook={handleDeactivateWebhook}
      onRegisterSlackWebhook={handleRegisterSlackWebhook}
      onDeactivateSlackWebhook={handleDeactivateSlackWebhook}
      onRegisterDiscordWebhook={handleRegisterDiscordWebhook}
      onDeactivateDiscordWebhook={handleDeactivateDiscordWebhook}
      routingRulesPanel={<RoutingRulesPanel />}
      deliveryLogPanel={<DeliveryLogPanel />}
      assignmentsPanel={<ScopeAssignmentPanel />}
      analyticsPanel={<CommsAnalytics />}
      testing={testing}
      testResult={testResult}
    />
  )
}
