/**
 * ChannelConfigPanel — Full config panel for a selected channel.
 * Absorbs the expandable body sections from CoreCommsSettings:
 * bot token, webhook URL, SMTP fields, test button, enable/disable toggle,
 * webhook management for Telegram, priority filters.
 */

import { useState, useCallback } from 'react'
import { PRIORITIES } from '../../hooks/useCommsData'
import CredentialPicker from '../integrations/CredentialPicker'
import './comms-layout.css'

export default function ChannelConfigPanel({
  channelType,
  config,
  webhookInfo,
  slackWebhookInfo,
  telegramBots,
  discordWebhookInfo,
  webhookEndpoints,
  onUpdate,
  onTogglePriority,
  onTest,
  onSave,
  onRegisterWebhook,
  onDeactivateWebhook,
  onRegisterSlackWebhook,
  onDeactivateSlackWebhook,
  onRegisterDiscordWebhook,
  onDeactivateDiscordWebhook,
  onBack,
  testing,
  testResult,
  orgName,
}) {
  const [webhookUrl, setWebhookUrl] = useState(webhookInfo?.webhook_url || '')
  const [slackWebhookUrl, setSlackWebhookUrl] = useState(slackWebhookInfo?.webhook_url || '')
  const [webhookLoading, setWebhookLoading] = useState(false)
  const [slackWebhookLoading, setSlackWebhookLoading] = useState(false)
  const [discordWebhookLoading, setDiscordWebhookLoading] = useState(false)

  // Sync webhookUrl when webhookInfo updates (P1: stale state fix)
  const prevWebhookUrl = webhookInfo?.webhook_url || ''
  if (webhookUrl !== prevWebhookUrl && prevWebhookUrl && !webhookUrl) {
    setWebhookUrl(prevWebhookUrl)
  }

  const channelConfig = config?.[channelType]

  // Channels without explicit config entries get a minimal default
  if (!channelConfig) {
    return (
      <div style={{ maxWidth: 640 }}>
        <div className="comms-content__header">
          <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', marginRight: 12 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          </button>
          <h2 style={{ margin: 0, fontSize: '1.25rem' }}>{channelType.charAt(0).toUpperCase() + channelType.slice(1)} Configuration</h2>
        </div>
        <p style={{ color: 'var(--text-secondary)', marginTop: 24 }}>
          This channel is managed via the Vault credential system. Configure credentials in
          Settings &gt; Integrations to enable {channelType.charAt(0).toUpperCase() + channelType.slice(1)} notifications,
          then routing rules will dispatch to it automatically.
        </p>
      </div>
    )
  }

  const titles = {
    telegram: 'Telegram Configuration',
    slack: 'Slack Configuration',
    discord: 'Discord Configuration',
    email: 'Email Configuration',
    msteams: 'Microsoft Teams Configuration',
    'twilio-sms': 'Twilio SMS Configuration',
    pagerduty: 'PagerDuty Configuration',
    opsgenie: 'OpsGenie Configuration',
    mattermost: 'Mattermost Configuration',
    ntfy: 'ntfy Configuration',
    pushover: 'Pushover Configuration',
    'google-chat': 'Google Chat Configuration',
    gotify: 'Gotify Configuration',
    rocketchat: 'Rocket.Chat Configuration',
    line: 'LINE Notify Configuration',
    webhook: 'Webhook Configuration',
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="comms-content__header">
        <h2 className="comms-content__title">
          {onBack && (
            <button className="comms-btn comms-btn--ghost comms-btn--sm" onClick={onBack}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
          )}
          {titles[channelType] || `${channelType} Configuration`}
          {orgName && <span style={{ fontSize: '13px', fontWeight: 400, opacity: 0.5, marginLeft: 8 }}>({orgName})</span>}
        </h2>
        <label className="corecomms-toggle" style={{ transform: 'scale(1.1)' }}>
          <input
            type="checkbox"
            checked={channelConfig.enabled || false}
            onChange={e => onUpdate(channelType, { enabled: e.target.checked })}
          />
          <span className="corecomms-toggle__slider"></span>
        </label>
      </div>

      {/* Toast */}
      {testResult && (
        <div className={`corecomms-toast corecomms-toast--${testResult.success ? 'success' : 'error'}`} style={{ marginBottom: 16 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {testResult.success ? (
              <polyline points="20,6 9,17 4,12"/>
            ) : (
              <>
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
              </>
            )}
          </svg>
          <span>{testResult.message || testResult.error || (testResult.success ? 'Success!' : 'Failed')}</span>
        </div>
      )}

      {/* Telegram */}
      {channelType === 'telegram' && (
        <>
          <div className="corecomms-field">
            <label className="corecomms-field__label">Bot Credential</label>
            <CredentialPicker
              type="telegram"
              value={channelConfig.vault_credential_id || ''}
              onSelect={(cred) => onUpdate('telegram', { vault_credential_id: cred.id })}
              allowCreate={true}
              showHealth={true}
              compact
              placeholder="Select Telegram bot credential from vault..."
            />
          </div>
          {!channelConfig.vault_credential_id && (
            <>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '8px' }}>
                Or enter bot token manually:
              </div>
              <div className="corecomms-field">
                <label className="corecomms-field__label">Bot Token</label>
                <input
                  type="text"
                  className="corecomms-field__input"
                  placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
                  value={channelConfig.botToken || ''}
                  onChange={e => onUpdate('telegram', { botToken: e.target.value })}
                />
                <span className="corecomms-field__help">
                  Create a bot via <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a> on Telegram
                </span>
              </div>
            </>
          )}
          <div className="corecomms-field">
            <label className="corecomms-field__label">Chat ID</label>
            <input
              type="text"
              className="corecomms-field__input"
              placeholder="-1001234567890 or your user ID"
              value={channelConfig.chatId || ''}
              onChange={e => onUpdate('telegram', { chatId: e.target.value })}
            />
            <span className="corecomms-field__help">
              Your user ID or group chat ID. Start a chat with the bot first.
            </span>
          </div>
        </>
      )}

      {/* Slack */}
      {channelType === 'slack' && (
        <div className="corecomms-field">
          <label className="corecomms-field__label">Webhook URL</label>
          <input
            type="text"
            className="corecomms-field__input"
            placeholder="https://hooks.slack.com/services/T.../B.../..."
            value={channelConfig.webhookUrl || ''}
            onChange={e => onUpdate('slack', { webhookUrl: e.target.value })}
          />
          <span className="corecomms-field__help">
            Create an incoming webhook in your Slack workspace settings
          </span>
        </div>
      )}

      {/* Discord */}
      {channelType === 'discord' && (
        <div className="corecomms-field">
          <label className="corecomms-field__label">Webhook URL</label>
          <input
            type="text"
            className="corecomms-field__input"
            placeholder="https://discord.com/api/webhooks/..."
            value={channelConfig.webhookUrl || ''}
            onChange={e => onUpdate('discord', { webhookUrl: e.target.value })}
          />
          <span className="corecomms-field__help">
            Server Settings &rarr; Integrations &rarr; Webhooks &rarr; New Webhook
          </span>
        </div>
      )}

      {/* Email */}
      {channelType === 'email' && (
        <>
          {/* Vault credential picker (primary) */}
          <div className="corecomms-field">
            <label className="corecomms-field__label">SMTP Credential</label>
            <CredentialPicker
              type="smtp"
              value={channelConfig.vault_credential_id || ''}
              onSelect={(cred) => onUpdate('email', { vault_credential_id: cred.id })}
              allowCreate={true}
              showHealth={true}
              placeholder="Select SMTP credential from vault..."
            />
            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '4px', display: 'block' }}>
              SMTP credentials are stored encrypted in QuoxVault
            </span>
          </div>

          {/* No vault credential selected: falls back to the instance-wide email setup */}
          {!channelConfig.vault_credential_id && (
            <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '16px', lineHeight: 1.5 }}>
              This org uses the instance email setup configured in Settings &gt; Email &amp; SMTP.
              Selecting a credential above overrides it for this org only.
            </div>
          )}

          <div className="corecomms-field">
            <label className="corecomms-field__label">Send To</label>
            <input
              type="email"
              className="corecomms-field__input"
              placeholder="alerts@yourcompany.com"
              value={channelConfig.to || ''}
              onChange={e => onUpdate('email', { to: e.target.value })}
            />
          </div>
        </>
      )}

      {/* MS Teams */}
      {channelType === 'msteams' && (
        <div className="corecomms-field">
          <label className="corecomms-field__label">Webhook URL</label>
          <input
            type="text"
            className="corecomms-field__input"
            placeholder="https://outlook.webhook.office.com/webhookb2/..."
            value={channelConfig.webhookUrl || ''}
            onChange={e => onUpdate('msteams', { webhookUrl: e.target.value })}
          />
          <span className="corecomms-field__help">
            Create a webhook connector in your Teams channel settings
          </span>
        </div>
      )}

      {/* Twilio SMS */}
      {channelType === 'twilio-sms' && (
        <>
          <div className="corecomms-field-row">
            <div className="corecomms-field">
              <label className="corecomms-field__label">Account SID</label>
              <input
                type="text"
                className="corecomms-field__input"
                placeholder="ACxxxxxxxxxxxxxxxx"
                value={channelConfig.accountSid || ''}
                onChange={e => onUpdate('twilio-sms', { accountSid: e.target.value })}
              />
            </div>
            <div className="corecomms-field">
              <label className="corecomms-field__label">Auth Token</label>
              <input
                type="password"
                className="corecomms-field__input"
                placeholder="Auth token"
                value={channelConfig.authToken || ''}
                onChange={e => onUpdate('twilio-sms', { authToken: e.target.value })}
              />
            </div>
          </div>
          <div className="corecomms-field-row">
            <div className="corecomms-field">
              <label className="corecomms-field__label">From Number</label>
              <input
                type="text"
                className="corecomms-field__input"
                placeholder="+1234567890"
                value={channelConfig.fromNumber || ''}
                onChange={e => onUpdate('twilio-sms', { fromNumber: e.target.value })}
              />
            </div>
            <div className="corecomms-field">
              <label className="corecomms-field__label">To Number</label>
              <input
                type="text"
                className="corecomms-field__input"
                placeholder="+1234567890"
                value={channelConfig.toNumber || ''}
                onChange={e => onUpdate('twilio-sms', { toNumber: e.target.value })}
              />
            </div>
          </div>
          <span className="corecomms-field__help">
            Get credentials from your Twilio Console
          </span>
        </>
      )}

      {/* PagerDuty */}
      {channelType === 'pagerduty' && (
        <div className="corecomms-field">
          <label className="corecomms-field__label">Integration / Routing Key</label>
          <input
            type="text"
            className="corecomms-field__input"
            placeholder="R0xxxxxxxxxxxxxxxxxxxxxxxx"
            value={channelConfig.routingKey || ''}
            onChange={e => onUpdate('pagerduty', { routingKey: e.target.value })}
          />
          <span className="corecomms-field__help">
            Found in PagerDuty &rarr; Service &rarr; Integrations &rarr; Events API v2
          </span>
        </div>
      )}

      {/* OpsGenie */}
      {channelType === 'opsgenie' && (
        <>
          <div className="corecomms-field">
            <label className="corecomms-field__label">API Key</label>
            <input
              type="password"
              className="corecomms-field__input"
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              value={channelConfig.apiKey || ''}
              onChange={e => onUpdate('opsgenie', { apiKey: e.target.value })}
            />
          </div>
          <div className="corecomms-field">
            <label className="corecomms-field__label">Region</label>
            <select
              className="corecomms-field__input"
              value={channelConfig.region || 'us'}
              onChange={e => onUpdate('opsgenie', { region: e.target.value })}
            >
              <option value="us">US (api.opsgenie.com)</option>
              <option value="eu">EU (api.eu.opsgenie.com)</option>
            </select>
          </div>
          <span className="corecomms-field__help">
            Create an API integration in OpsGenie &rarr; Settings &rarr; Integrations
          </span>
        </>
      )}

      {/* Mattermost */}
      {channelType === 'mattermost' && (
        <div className="corecomms-field">
          <label className="corecomms-field__label">Webhook URL</label>
          <input
            type="text"
            className="corecomms-field__input"
            placeholder="https://mattermost.example.com/hooks/xxxxxxxxxx"
            value={channelConfig.webhookUrl || ''}
            onChange={e => onUpdate('mattermost', { webhookUrl: e.target.value })}
          />
          <span className="corecomms-field__help">
            Main Menu &rarr; Integrations &rarr; Incoming Webhooks
          </span>
        </div>
      )}

      {/* ntfy */}
      {channelType === 'ntfy' && (
        <>
          <div className="corecomms-field">
            <label className="corecomms-field__label">Server URL</label>
            <input
              type="text"
              className="corecomms-field__input"
              placeholder="https://ntfy.sh"
              value={channelConfig.serverUrl || 'https://ntfy.sh'}
              onChange={e => onUpdate('ntfy', { serverUrl: e.target.value })}
            />
          </div>
          <div className="corecomms-field">
            <label className="corecomms-field__label">Topic</label>
            <input
              type="text"
              className="corecomms-field__input"
              placeholder="quoxcore-alerts"
              value={channelConfig.topic || ''}
              onChange={e => onUpdate('ntfy', { topic: e.target.value })}
            />
          </div>
          <span className="corecomms-field__help">
            Subscribe to this topic in the ntfy app to receive alerts
          </span>
        </>
      )}

      {/* Pushover */}
      {channelType === 'pushover' && (
        <>
          <div className="corecomms-field">
            <label className="corecomms-field__label">User Key</label>
            <input
              type="text"
              className="corecomms-field__input"
              placeholder="uxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={channelConfig.userKey || ''}
              onChange={e => onUpdate('pushover', { userKey: e.target.value })}
            />
          </div>
          <div className="corecomms-field">
            <label className="corecomms-field__label">API Token</label>
            <input
              type="text"
              className="corecomms-field__input"
              placeholder="axxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={channelConfig.apiToken || ''}
              onChange={e => onUpdate('pushover', { apiToken: e.target.value })}
            />
          </div>
          <span className="corecomms-field__help">
            Find these in your Pushover dashboard at pushover.net
          </span>
        </>
      )}

      {/* Google Chat */}
      {channelType === 'google-chat' && (
        <div className="corecomms-field">
          <label className="corecomms-field__label">Webhook URL</label>
          <input
            type="text"
            className="corecomms-field__input"
            placeholder="https://chat.googleapis.com/v1/spaces/..."
            value={channelConfig.webhookUrl || ''}
            onChange={e => onUpdate('google-chat', { webhookUrl: e.target.value })}
          />
          <span className="corecomms-field__help">
            Space &rarr; Apps &amp; integrations &rarr; Manage webhooks
          </span>
        </div>
      )}

      {/* Gotify */}
      {channelType === 'gotify' && (
        <>
          <div className="corecomms-field">
            <label className="corecomms-field__label">Server URL</label>
            <input
              type="text"
              className="corecomms-field__input"
              placeholder="https://gotify.example.com"
              value={channelConfig.serverUrl || ''}
              onChange={e => onUpdate('gotify', { serverUrl: e.target.value })}
            />
          </div>
          <div className="corecomms-field">
            <label className="corecomms-field__label">App Token</label>
            <input
              type="text"
              className="corecomms-field__input"
              placeholder="Axxxxxxxxxx"
              value={channelConfig.appToken || ''}
              onChange={e => onUpdate('gotify', { appToken: e.target.value })}
            />
          </div>
          <span className="corecomms-field__help">
            Create an application in Gotify to get an app token
          </span>
        </>
      )}

      {/* Rocket.Chat */}
      {channelType === 'rocketchat' && (
        <div className="corecomms-field">
          <label className="corecomms-field__label">Webhook URL</label>
          <input
            type="text"
            className="corecomms-field__input"
            placeholder="https://chat.example.com/hooks/xxxxxxxxxx"
            value={channelConfig.webhookUrl || ''}
            onChange={e => onUpdate('rocketchat', { webhookUrl: e.target.value })}
          />
          <span className="corecomms-field__help">
            Administration &rarr; Integrations &rarr; Incoming WebHook
          </span>
        </div>
      )}

      {/* LINE */}
      {channelType === 'line' && (
        <div className="corecomms-field">
          <label className="corecomms-field__label">Access Token</label>
          <input
            type="password"
            className="corecomms-field__input"
            placeholder="LINE Notify access token"
            value={channelConfig.accessToken || ''}
            onChange={e => onUpdate('line', { accessToken: e.target.value })}
          />
          <span className="corecomms-field__help">
            Generate a token at <a href="https://notify-bot.line.me/" target="_blank" rel="noopener noreferrer">LINE Notify</a>
          </span>
        </div>
      )}

      {/* Webhook (generic) */}
      {channelType === 'webhook' && (
        <>
          <div className="corecomms-field">
            <label className="corecomms-field__label">URL</label>
            <input
              type="text"
              className="corecomms-field__input"
              placeholder="https://example.com/webhook"
              value={channelConfig.url || ''}
              onChange={e => onUpdate('webhook', { url: e.target.value })}
            />
          </div>
          <div className="corecomms-field-row">
            <div className="corecomms-field corecomms-field--small">
              <label className="corecomms-field__label">Method</label>
              <select
                className="corecomms-field__input"
                value={channelConfig.method || 'POST'}
                onChange={e => onUpdate('webhook', { method: e.target.value })}
              >
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
              </select>
            </div>
            <div className="corecomms-field">
              <label className="corecomms-field__label">Custom Headers (JSON)</label>
              <input
                type="text"
                className="corecomms-field__input"
                placeholder='{"Authorization": "Bearer ..."}'
                value={channelConfig.headers || ''}
                onChange={e => onUpdate('webhook', { headers: e.target.value })}
              />
            </div>
          </div>
          <span className="corecomms-field__help">
            Sends a JSON payload with title, message, priority, and kind
          </span>
        </>
      )}

      {/* Priority Filters (all channels) */}
      <div className="corecomms-field" style={{ marginTop: 16 }}>
        <label className="corecomms-field__label">Notify on Priorities</label>
        <div className="corecomms-priorities">
          {PRIORITIES.map(p => (
            <label key={p} className="corecomms-priority">
              <input
                type="checkbox"
                checked={channelConfig.priorities?.includes(p) || false}
                onChange={() => onTogglePriority(channelType, p)}
              />
              <span className={`corecomms-priority__badge corecomms-priority__badge--${p}`}>{p}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
        <button
          className="comms-btn comms-btn--primary"
          onClick={onSave}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
            <polyline points="17,21 17,13 7,13 7,21"/>
            <polyline points="7,3 7,8 15,8"/>
          </svg>
          Save
        </button>
        {onTest && (
          <button
            className="comms-btn"
            onClick={() => onTest(channelType)}
            disabled={testing === channelType}
          >
            {testing === channelType ? (
              <>
                <svg className="corecomms-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20"/>
                </svg>
                Testing...
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                  <polyline points="22,4 12,14.01 9,11.01"/>
                </svg>
                Test Connection
              </>
            )}
          </button>
        )}
      </div>

      {/* Telegram Inbound Webhook Section */}
      {channelType === 'telegram' && webhookInfo && (
        <div className="corecomms-webhook-section" style={{ marginTop: 24 }}>
          <div className="corecomms-webhook-section__header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span>Inbound Messages</span>
            {webhookInfo.active && <span className="comms-badge comms-badge--success">Active</span>}
            {!webhookInfo.active && webhookInfo.has_token && <span className="comms-badge comms-badge--warning">Inactive</span>}
            {!webhookInfo.has_token && <span className="comms-badge comms-badge--neutral">No Bot Token</span>}
          </div>
          <p className="corecomms-field__help" style={{ marginBottom: 8 }}>
            Enable inbound messages so users can message the bot on Telegram and get routed to CommanderQ.
            {!webhookInfo.has_token && ' Add a Telegram bot token in Integrations Vault first.'}
          </p>

          {webhookInfo.has_token && (
            <>
              {webhookInfo.bot_username && (
                <div style={{ fontSize: 12, color: 'var(--ui-text-secondary, #999)', marginBottom: 8 }}>
                  Bot: @{webhookInfo.bot_username}
                  {webhookInfo.pending_update_count > 0 && (
                    <span className="comms-badge comms-badge--error" style={{ marginLeft: 8, fontSize: 11 }}>
                      {webhookInfo.pending_update_count} pending
                    </span>
                  )}
                </div>
              )}
              <div className="corecomms-field">
                <label className="corecomms-field__label">Webhook URL</label>
                <input
                  type="text"
                  className="corecomms-field__input"
                  placeholder="https://yourdomain.com/webhook/telegram/"
                  value={webhookUrl}
                  onChange={e => setWebhookUrl(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {!webhookInfo.active ? (
                  <button
                    className="comms-btn comms-btn--primary"
                    disabled={webhookLoading || !webhookUrl}
                    onClick={async () => {
                      setWebhookLoading(true)
                      try {
                        await onRegisterWebhook?.(webhookUrl)
                      } finally {
                        setWebhookLoading(false)
                      }
                    }}
                  >
                    {webhookLoading ? 'Registering...' : 'Activate Webhook'}
                  </button>
                ) : (
                  <button
                    className="comms-btn comms-btn--danger"
                    disabled={webhookLoading}
                    onClick={async () => {
                      setWebhookLoading(true)
                      try {
                        await onDeactivateWebhook?.()
                      } finally {
                        setWebhookLoading(false)
                      }
                    }}
                  >
                    Deactivate Webhook
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Telegram Multi-Bot Section */}
      {channelType === 'telegram' && telegramBots && telegramBots.length > 0 && (
        <div className="corecomms-webhook-section" style={{ marginTop: 16 }}>
          <div className="corecomms-webhook-section__header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            <span>Registered Bots ({telegramBots.length})</span>
          </div>
          <p className="corecomms-field__help" style={{ marginBottom: 8 }}>
            Multiple bots can be configured for different teams or environments.
            Manage bot tokens in Settings &rarr; Integrations Vault.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {telegramBots.map(bot => (
              <div key={bot.id} className="corecomms-bot-item">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary, #e0e0e0)' }}>
                    {bot.label || bot.id}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary, #999)' }}>
                    {bot.key_preview || 'Token configured'}{bot.is_default ? ' · Default' : ''}
                  </div>
                </div>
                <span className={`comms-badge comms-badge--${bot.status === 'active' ? 'success' : 'neutral'}`} style={{ fontSize: 10 }}>
                  {bot.status === 'active' ? 'Active' : 'Stored'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Slack Inbound Webhook Section */}
      {channelType === 'slack' && slackWebhookInfo && (
        <div className="corecomms-webhook-section" style={{ marginTop: 24 }}>
          <div className="corecomms-webhook-section__header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span>Inbound Messages (Events API)</span>
            {slackWebhookInfo.active && <span className="comms-badge comms-badge--success">Active</span>}
            {!slackWebhookInfo.active && slackWebhookInfo.has_token && <span className="comms-badge comms-badge--warning">Inactive</span>}
            {!slackWebhookInfo.has_token && <span className="comms-badge comms-badge--neutral">No Bot Token</span>}
          </div>
          <p className="corecomms-field__help" style={{ marginBottom: 8 }}>
            Enable the Slack Events API so users can message the bot in Slack and get routed to CommanderQ.
            {!slackWebhookInfo.has_token && ' Add a Slack bot token (xoxb-) in Integrations Vault first.'}
          </p>

          {slackWebhookInfo.has_token && (
            <>
              {slackWebhookInfo.bot_username && (
                <div style={{ fontSize: 12, color: 'var(--ui-text-secondary, #999)', marginBottom: 8 }}>
                  Bot: @{slackWebhookInfo.bot_username}
                  {slackWebhookInfo.team && <span> · Team: {slackWebhookInfo.team}</span>}
                </div>
              )}
              <div className="corecomms-field">
                <label className="corecomms-field__label">Events API Request URL</label>
                <input
                  type="text"
                  className="corecomms-field__input"
                  placeholder="https://yourdomain.com/webhook/slack"
                  value={slackWebhookUrl}
                  onChange={e => setSlackWebhookUrl(e.target.value)}
                />
                <span className="corecomms-field__help">
                  Set this URL in your Slack App &rarr; Event Subscriptions &rarr; Request URL
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {!slackWebhookInfo.active ? (
                  <button
                    className="comms-btn comms-btn--primary"
                    disabled={slackWebhookLoading || !slackWebhookUrl}
                    onClick={async () => {
                      setSlackWebhookLoading(true)
                      try {
                        await onRegisterSlackWebhook?.(slackWebhookUrl)
                      } finally {
                        setSlackWebhookLoading(false)
                      }
                    }}
                  >
                    {slackWebhookLoading ? 'Verifying...' : 'Activate Events API'}
                  </button>
                ) : (
                  <button
                    className="comms-btn comms-btn--danger"
                    disabled={slackWebhookLoading}
                    onClick={async () => {
                      setSlackWebhookLoading(true)
                      try {
                        await onDeactivateSlackWebhook?.()
                      } finally {
                        setSlackWebhookLoading(false)
                      }
                    }}
                  >
                    Deactivate Events API
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Discord Inbound Interactions Section */}
      {channelType === 'discord' && discordWebhookInfo && (
        <div className="corecomms-webhook-section" style={{ marginTop: 24 }}>
          <div className="corecomms-webhook-section__header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span>Inbound Messages (Interactions)</span>
            {discordWebhookInfo.active && <span className="comms-badge comms-badge--success">Active</span>}
            {!discordWebhookInfo.active && discordWebhookInfo.has_token && <span className="comms-badge comms-badge--warning">Inactive</span>}
            {!discordWebhookInfo.has_token && <span className="comms-badge comms-badge--neutral">No Bot Token</span>}
          </div>
          <p className="corecomms-field__help" style={{ marginBottom: 8 }}>
            Enable the Discord Interactions endpoint so users can use /ask commands and message your bot.
            {!discordWebhookInfo.has_token && ' Add a Discord bot token in Integrations Vault first.'}
          </p>

          {discordWebhookInfo.has_token && (
            <>
              {discordWebhookInfo.bot_username && (
                <div style={{ fontSize: 12, color: 'var(--ui-text-secondary, #999)', marginBottom: 8 }}>
                  Bot: @{discordWebhookInfo.bot_username}
                  {discordWebhookInfo.application_id && <span> · App: {discordWebhookInfo.application_id}</span>}
                </div>
              )}
              <div className="corecomms-field">
                <label className="corecomms-field__label">Interactions Endpoint URL</label>
                <input
                  type="text"
                  className="corecomms-field__input"
                  readOnly
                  value={discordWebhookInfo.interactions_url || '/webhook/discord'}
                  style={{ opacity: 0.7, cursor: 'default' }}
                />
                <span className="corecomms-field__help">
                  Set this URL in your Discord App &rarr; General &rarr; Interactions Endpoint URL
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {!discordWebhookInfo.active ? (
                  <button
                    className="comms-btn comms-btn--primary"
                    disabled={discordWebhookLoading}
                    onClick={async () => {
                      setDiscordWebhookLoading(true)
                      try {
                        await onRegisterDiscordWebhook?.({})
                      } finally {
                        setDiscordWebhookLoading(false)
                      }
                    }}
                  >
                    {discordWebhookLoading ? 'Setting up...' : 'Activate Interactions'}
                  </button>
                ) : (
                  <button
                    className="comms-btn comms-btn--danger"
                    disabled={discordWebhookLoading}
                    onClick={async () => {
                      setDiscordWebhookLoading(true)
                      try {
                        await onDeactivateDiscordWebhook?.()
                      } finally {
                        setDiscordWebhookLoading(false)
                      }
                    }}
                  >
                    Deactivate Interactions
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Generic Webhook Endpoints Section */}
      {channelType === 'webhook' && webhookEndpoints && (
        <div className="corecomms-webhook-section" style={{ marginTop: 24 }}>
          <div className="corecomms-webhook-section__header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
            <span>Inbound Webhook Endpoints ({webhookEndpoints.length})</span>
          </div>
          <p className="corecomms-field__help" style={{ marginBottom: 8 }}>
            Generic webhook endpoints accept POST requests from external systems with configurable
            payload mapping. Each endpoint gets a unique URL and optional HMAC signature verification.
          </p>

          {webhookEndpoints.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
              {webhookEndpoints.map(ep => (
                <div key={ep.id} className="corecomms-bot-item">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary, #e0e0e0)' }}>
                      {ep.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary, #999)', fontFamily: 'monospace' }}>
                      /webhook/inbound/{ep.id}
                    </div>
                  </div>
                  <span className={`comms-badge comms-badge--${ep.enabled ? 'success' : 'neutral'}`} style={{ fontSize: 10 }}>
                    {ep.enabled ? 'Active' : 'Disabled'}
                  </span>
                </div>
              ))}
            </div>
          )}

          <p className="corecomms-field__help" style={{ fontSize: 11 }}>
            Manage webhook endpoints via the API: POST /api/orgs/:orgId/webhook-endpoints
          </p>
        </div>
      )}
    </div>
  )
}
