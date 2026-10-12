/**
 * CoreComms Service
 *
 * External notification channels for HITL alerts.
 * Supports Telegram, Slack, and Email.
 *
 * Usage:
 *   import { sendNotification, testTelegram, testSlack } from './coreCommsService'
 *
 *   // Test a channel
 *   const result = await testTelegram(botToken, chatId)
 *
 *   // Send notification (called automatically by alertService)
 *   await sendNotification(inboxItem)
 */

import { csrfFetch } from '../utils/csrfFetch'
import { orgGet, orgSet } from './orgScopedStorage'

import { isPluginLicensedSync } from './pluginClient'
import {
  logConfigSaved, logConfigReset, logNotificationSent,
  logWebhookRegistered, logWebhookDeactivated,
  logEndpointCreated, logEndpointUpdated, logEndpointDeleted,
} from './commsAudit'

// Storage keys (org-scoped for multi-org isolation)
const getConfigKey = (orgId) => orgId ? `quox_corecomms_config_${orgId}` : 'quox_corecomms_config'
const getFailuresKey = (orgId) => orgId ? `quox_corecomms_failures_${orgId}` : 'quox_corecomms_failures'
const getCooldownKey = (orgId) => orgId ? `quox_corecomms_cooldown_${orgId}` : 'quox_corecomms_cooldown'
// Legacy keys for backward compat
const CONFIG_KEY = 'quox_corecomms_config'
const FAILURES_KEY = 'quox_corecomms_failures'
const COOLDOWN_KEY = 'quox_corecomms_cooldown'

// Retry configuration
const RETRY_CONFIG = {
  maxAttempts: 3,
  backoffMs: [1000, 5000, 15000],
  failureThreshold: 5, // Disable channel after 5 consecutive failures
  cooldownMs: 60000 // Minimum 60 seconds between notifications per channel
}

// Priority levels — aligned with backend routing rules and channel drivers
export const PRIORITIES = ['urgent', 'high', 'normal', 'low']

// Default configuration
const DEFAULT_CONFIG = {
  telegram: {
    enabled: false,
    botToken: '',
    chatId: '',
    priorities: ['critical', 'high'],
    lastTest: null,
    testStatus: null // 'success', 'error', null
  },
  slack: {
    enabled: false,
    webhookUrl: '',
    channel: '',
    priorities: ['critical', 'high', 'medium'],
    lastTest: null,
    testStatus: null
  },
  discord: {
    enabled: false,
    webhookUrl: '',
    priorities: ['critical', 'high', 'medium'],
    lastTest: null,
    testStatus: null
  },
  email: {
    enabled: false,
    smtp: {
      host: '',
      port: 587,
      user: '',
      pass: '',
      secure: false
    },
    to: '',
    from: '',
    priorities: ['critical'],
    lastTest: null,
    testStatus: null
  },
  msteams: {
    enabled: false,
    webhookUrl: '',
    priorities: ['critical', 'high', 'medium'],
    lastTest: null,
    testStatus: null
  },
  'twilio-sms': {
    enabled: false,
    accountSid: '',
    authToken: '',
    fromNumber: '',
    toNumber: '',
    priorities: ['critical', 'high'],
    lastTest: null,
    testStatus: null
  },
  pagerduty: {
    enabled: false,
    routingKey: '',
    priorities: ['critical'],
    lastTest: null,
    testStatus: null
  },
  opsgenie: {
    enabled: false,
    apiKey: '',
    region: 'us',
    priorities: ['critical', 'high'],
    lastTest: null,
    testStatus: null
  },
  mattermost: {
    enabled: false,
    webhookUrl: '',
    priorities: ['critical', 'high', 'medium'],
    lastTest: null,
    testStatus: null
  },
  ntfy: {
    enabled: false,
    serverUrl: 'https://ntfy.sh',
    topic: '',
    priorities: ['critical', 'high'],
    lastTest: null,
    testStatus: null
  },
  pushover: {
    enabled: false,
    userKey: '',
    apiToken: '',
    priorities: ['critical', 'high'],
    lastTest: null,
    testStatus: null
  },
  'google-chat': {
    enabled: false,
    webhookUrl: '',
    priorities: ['critical', 'high', 'medium'],
    lastTest: null,
    testStatus: null
  },
  gotify: {
    enabled: false,
    serverUrl: '',
    appToken: '',
    priorities: ['critical', 'high'],
    lastTest: null,
    testStatus: null
  },
  rocketchat: {
    enabled: false,
    webhookUrl: '',
    priorities: ['critical', 'high', 'medium'],
    lastTest: null,
    testStatus: null
  },
  line: {
    enabled: false,
    accessToken: '',
    priorities: ['critical', 'high'],
    lastTest: null,
    testStatus: null
  },
  webhook: {
    enabled: false,
    url: '',
    method: 'POST',
    headers: '',
    priorities: ['critical', 'high', 'medium'],
    lastTest: null,
    testStatus: null
  }
}

// Secret field path per channel: the single source of truth for which field holds the
// credential. Dot-path syntax for nested fields (e.g. 'smtp.pass'). Used by saveConfig()
// (redacts the server-sync payload), migrateToVault() (strips a channel's secret once it
// has moved to the vault) and LOCAL_REDACT_CHANNELS below, so the enumerations cannot drift.
const SECRET_FIELDS = {
  telegram: 'botToken',
  slack: 'webhookUrl',
  discord: 'webhookUrl',
  msteams: 'webhookUrl',
  mattermost: 'webhookUrl',
  'google-chat': 'webhookUrl',
  rocketchat: 'webhookUrl',
  email: 'smtp.pass',
  twilio: 'authToken',
  pagerduty: 'routingKey',
  opsgenie: 'apiKey',
  pushover: 'apiToken',
  gotify: 'appToken',
  line: 'accessToken',
  webhook: 'headers',
}

// Channels whose secret is redacted from localStorage on EVERY save.
//
// EMAIL-UNIFY P2 removes the SMTP password, the smell the audit named: nothing in the browser
// needs it any more, because /api/notifications/{test-email,send-email} resolve the transport
// server-side from QuoxVault.
//
// The other channels are deliberately NOT in this list yet. Their browser send paths still read
// the token straight out of the saved config (see sendTelegram, sendSlack and the webhook
// senders below), so redacting at save time would break sending until those paths are moved
// server-side the way email now is. migrateToVault() still strips them once they reach the
// vault, exactly as before.
const LOCAL_REDACT_CHANNELS = ['email']

/**
 * Delete a (possibly nested) field from an object given a dot-path, e.g. 'smtp.pass'.
 */
function deleteSecretField(obj, path) {
  const parts = path.split('.')
  let target = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!target || typeof target !== 'object') return
    target = target[parts[i]]
  }
  if (target && typeof target === 'object') delete target[parts[parts.length - 1]]
}

// Track auto-migration trigger to avoid repeated calls
let _autoMigrateTriggered = false

/**
 * Get CoreComms configuration
 * @param {string} [orgId] - Org ID for multi-org config isolation
 */
export function getConfig(orgId) {
  try {
    const key = getConfigKey(orgId)
    const stored = localStorage.getItem(key)

    // Auto-trigger vault migration on first getConfig() call if not yet migrated
    if (orgId && !_autoMigrateTriggered) {
      const migrationKey = `quox_vault_migrated_${orgId}`
      if (localStorage.getItem(migrationKey) !== 'true') {
        _autoMigrateTriggered = true
        // Retry migration up to 3 times with backoff — secrets must leave localStorage
        ;(async () => {
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const result = await migrateToVault(orgId)
              if (result.alreadyDone || result.migrated > 0) break
              if (result.migrated === 0 && result.skipped === 0) break // nothing to migrate
            } catch (err) {
              console.warn(`[CoreComms] Auto-migration attempt ${attempt}/3 failed:`, err.message)
              if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 2000))
            }
          }
        })()
      } else {
        _autoMigrateTriggered = true
      }
    }

    if (stored) {
      const parsed = JSON.parse(stored)
      // Merge with defaults to ensure all fields exist
      const config = {}
      for (const [ch, defaults] of Object.entries(DEFAULT_CONFIG)) {
        config[ch] = { ...defaults, ...parsed[ch] }
      }
      // Deep merge email SMTP
      if (parsed.email?.smtp) {
        config.email.smtp = { ...DEFAULT_CONFIG.email.smtp, ...parsed.email.smtp }
      }
      return config
    }
    return { ...DEFAULT_CONFIG }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * Save CoreComms configuration (localStorage + server sync)
 * @param {object} config - Channel configuration
 * @param {string} [orgId] - Org ID for multi-org config isolation
 */
export function saveConfig(config, orgId) {
  try {
    const key = getConfigKey(orgId)

    // Two redactions, with different reach. The caller's in-memory config object is never
    // mutated (both start from a deep clone), so callers can still use it to test a connection
    // right after saving.

    // localStorage: only the channels whose send path no longer needs the secret client-side.
    const localCopy = JSON.parse(JSON.stringify(config))
    for (const ch of LOCAL_REDACT_CHANNELS) {
      if (localCopy[ch] && SECRET_FIELDS[ch]) deleteSecretField(localCopy[ch], SECRET_FIELDS[ch])
    }
    localStorage.setItem(key, JSON.stringify(localCopy))

    // Server sync: never any secret, for any channel. notification_channels exists so the
    // server can map an inbound chatId / slackUserId / discordUserId back to a Quox user
    // (see routes/inbox.js); it never reads a token out of config_json, so sending one was
    // storing a credential nothing would ever use.
    const serverCopy = JSON.parse(JSON.stringify(config))
    for (const ch of Object.keys(serverCopy)) {
      if (SECRET_FIELDS[ch]) deleteSecretField(serverCopy[ch], SECRET_FIELDS[ch])
    }
    for (const ch of Object.keys(DEFAULT_CONFIG)) {
      if (config[ch]) syncChannelToServer(ch, serverCopy[ch], orgId).catch(() => {})
    }

    logConfigSaved(orgId)
    return true
  } catch (err) {
    console.error('[CoreComms] Failed to save config:', err)
    return false
  }
}

/**
 * Sync a channel config to the server-side notification_channels table.
 * This enables server-side features (e.g. Telegram inbound user lookup)
 * to find the user's channel config without depending on localStorage.
 * @param {string} channelType - Channel type
 * @param {object} channelConfig - Channel configuration
 * @param {string} [orgId] - Org ID for multi-org isolation
 */
async function syncChannelToServer(channelType, channelConfig, orgId) {
  if (!channelConfig) return
  // The collector never reads notification_channels for email: SMTP transport is resolved
  // server-side from the vault (or instance config), so the per-user email row is inert.
  // Skip it entirely rather than writing SMTP fields into a row nothing reads.
  if (channelType === 'email') return
  try {
    await csrfFetch(`/api/users/me/notification-channels/${channelType}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: channelConfig.enabled || false,
        config: channelConfig,
        preferences: { priorities: channelConfig.priorities || [] },
        org_id: orgId || undefined
      })
    })
  } catch (err) {
    console.warn(`[CoreComms] Server sync for ${channelType} failed:`, err.message)
  }
}

/**
 * Reset configuration to defaults
 * @param {string} [orgId] - Org ID for multi-org config isolation
 */
export function resetConfig(orgId) {
  try {
    localStorage.removeItem(getConfigKey(orgId))
    localStorage.removeItem(getFailuresKey(orgId))
    localStorage.removeItem(getCooldownKey(orgId))
    logConfigReset(orgId)
    return true
  } catch {
    return false
  }
}

/**
 * Check if CoreComms plugin is active (licensed)
 */
export function isCoreCommsActive() {
  return isPluginLicensedSync('core-comms')
}

/**
 * Get failure count for a channel
 * @param {string} [orgId] - Org ID for multi-org isolation
 */
function getFailureCount(channel, orgId) {
  try {
    const stored = localStorage.getItem(getFailuresKey(orgId))
    const failures = stored ? JSON.parse(stored) : {}
    return failures[channel] || 0
  } catch {
    return 0
  }
}

/**
 * Record a failure for a channel
 * @param {string} [orgId] - Org ID for multi-org isolation
 */
function recordFailure(channel, orgId) {
  try {
    const key = getFailuresKey(orgId)
    const stored = localStorage.getItem(key)
    const failures = stored ? JSON.parse(stored) : {}
    failures[channel] = (failures[channel] || 0) + 1
    localStorage.setItem(key, JSON.stringify(failures))

    // Auto-disable if threshold exceeded
    if (failures[channel] >= RETRY_CONFIG.failureThreshold) {
      const config = getConfig(orgId)
      if (config[channel]) {
        config[channel].enabled = false
        saveConfig(config, orgId)
        console.warn(`[CoreComms] ${channel} disabled after ${failures[channel]} consecutive failures`)
      }
    }
  } catch (err) {
    console.error('[CoreComms] Failed to record failure:', err)
  }
}

/**
 * Clear failure count for a channel
 * @param {string} [orgId] - Org ID for multi-org isolation
 */
function clearFailures(channel, orgId) {
  try {
    const key = getFailuresKey(orgId)
    const stored = localStorage.getItem(key)
    const failures = stored ? JSON.parse(stored) : {}
    delete failures[channel]
    localStorage.setItem(key, JSON.stringify(failures))
  } catch {
    // Ignore
  }
}

/**
 * Check if channel is in cooldown
 * @param {string} [orgId] - Org ID for multi-org isolation
 */
function isInCooldown(channel, orgId) {
  try {
    const stored = localStorage.getItem(getCooldownKey(orgId))
    const cooldowns = stored ? JSON.parse(stored) : {}
    const lastSent = cooldowns[channel]
    if (!lastSent) return false
    return Date.now() - lastSent < RETRY_CONFIG.cooldownMs
  } catch {
    return false
  }
}

/**
 * Record cooldown for a channel
 * @param {string} [orgId] - Org ID for multi-org isolation
 */
function recordCooldown(channel, orgId) {
  try {
    const key = getCooldownKey(orgId)
    const stored = localStorage.getItem(key)
    const cooldowns = stored ? JSON.parse(stored) : {}
    cooldowns[channel] = Date.now()
    localStorage.setItem(key, JSON.stringify(cooldowns))
  } catch {
    // Ignore
  }
}

/**
 * Format inbox item for notification
 */
function formatNotification(item) {
  const priorityEmoji = {
    urgent: '🚨',
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    normal: '🔵',
    low: '⚪'
  }

  const emoji = priorityEmoji[item.priority] || '📌'
  const title = item.title || 'HITL Notification'
  const service = item.payload?.service_name || ''
  const status = item.payload?.service_status || ''

  return {
    emoji,
    title,
    service,
    status,
    priority: item.priority || 'normal',
    kind: item.kind || 'info',
    body: item.body_md || '',
    timestamp: new Date().toISOString()
  }
}

/**
 * Test Telegram connection
 * @param {string} botToken
 * @param {string} chatId
 * @param {string} [orgId] - Org ID for multi-org config isolation
 */
export async function testTelegram(botToken, chatId, orgId) {
  if (!botToken || !chatId) {
    return { success: false, error: 'Bot token and chat ID are required' }
  }

  try {
    // Use proxied endpoint to avoid CORS
    const url = `/telegram-api/bot${botToken}/sendMessage`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ *QuoxCore CoreComms* connected successfully!\n\nYou will receive HITL notifications here.',
        parse_mode: 'Markdown'
      })
    })

    const data = await response.json()

    if (response.ok && data.ok) {
      // Update test status in config
      const config = getConfig(orgId)
      config.telegram.lastTest = Date.now()
      config.telegram.testStatus = 'success'
      saveConfig(config, orgId)
      clearFailures('telegram', orgId)
      return { success: true }
    }

    // Handle specific Telegram errors
    const errorCode = data.error_code
    let errorMessage = data.description || 'Unknown error'

    if (errorCode === 401) {
      errorMessage = 'Invalid bot token. Create a bot via @BotFather on Telegram.'
    } else if (errorCode === 400 && errorMessage.includes('chat not found')) {
      errorMessage = 'Chat ID not found. Start a conversation with your bot first, then try again.'
    } else if (errorCode === 403) {
      errorMessage = 'Bot was blocked by user or has no access to this chat.'
    }

    const config = getConfig(orgId)
    config.telegram.lastTest = Date.now()
    config.telegram.testStatus = 'error'
    saveConfig(config, orgId)

    return { success: false, error: errorMessage }
  } catch (err) {
    const config = getConfig(orgId)
    config.telegram.lastTest = Date.now()
    config.telegram.testStatus = 'error'
    saveConfig(config, orgId)
    return { success: false, error: `Network error: ${err.message}` }
  }
}

/**
 * Send Telegram notification
 */
async function sendTelegram(item, config) {
  const { botToken, chatId, priorities } = config.telegram

  if (!botToken || !chatId) return false

  // Check priority filter
  const itemPriority = item.priority || 'normal'
  const priorityMap = { urgent: 'critical', high: 'high', medium: 'medium', normal: 'medium', low: 'low' }
  const mappedPriority = priorityMap[itemPriority] || 'medium'
  if (!priorities.includes(mappedPriority) && !priorities.includes(itemPriority)) {
    return true // Skip but don't fail
  }

  const notif = formatNotification(item)
  const text = `${notif.emoji} *${notif.title}*\n\n` +
    (notif.service ? `Service: ${notif.service}\n` : '') +
    (notif.status ? `Status: ${notif.status.toUpperCase()}\n` : '') +
    `Priority: ${notif.priority}\n` +
    `Type: ${notif.kind}\n\n` +
    `_Sent from QuoxCore_`

  try {
    const url = `/telegram-api/bot${botToken}/sendMessage`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown'
      })
    })

    if (response.ok) {
      clearFailures('telegram')
      return true
    }

    recordFailure('telegram')
    return false
  } catch {
    recordFailure('telegram')
    return false
  }
}

/**
 * Test Slack connection
 * @param {string} webhookUrl
 * @param {string} [orgId] - Org ID for multi-org config isolation
 */
export async function testSlack(webhookUrl, orgId) {
  if (!webhookUrl) {
    return { success: false, error: 'Webhook URL is required' }
  }

  // Validate URL format
  if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
    return { success: false, error: 'Invalid Slack webhook URL. Should start with https://hooks.slack.com/' }
  }

  try {
    // Convert to proxied URL to avoid CORS
    const proxiedUrl = webhookUrl.replace('https://hooks.slack.com', '/slack-webhook')
    const response = await fetch(proxiedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '✅ QuoxCore CoreComms connected successfully!',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*QuoxCore CoreComms* connected! :white_check_mark:\n\nYou will receive HITL notifications in this channel.'
            }
          }
        ]
      })
    })

    if (response.ok) {
      const config = getConfig(orgId)
      config.slack.lastTest = Date.now()
      config.slack.testStatus = 'success'
      saveConfig(config, orgId)
      clearFailures('slack', orgId)
      return { success: true }
    }

    let errorMessage = 'Failed to send to Slack'
    if (response.status === 404) {
      errorMessage = 'Webhook not found. The webhook URL may have been deleted or is invalid.'
    } else if (response.status === 403) {
      errorMessage = 'Access denied. Check your Slack app permissions.'
    } else if (response.status === 410) {
      errorMessage = 'Webhook has been revoked. Create a new incoming webhook in Slack.'
    }

    const config = getConfig(orgId)
    config.slack.lastTest = Date.now()
    config.slack.testStatus = 'error'
    saveConfig(config, orgId)

    return { success: false, error: errorMessage }
  } catch (err) {
    const config = getConfig(orgId)
    config.slack.lastTest = Date.now()
    config.slack.testStatus = 'error'
    saveConfig(config, orgId)
    return { success: false, error: `Network error: ${err.message}` }
  }
}

/**
 * Send Slack notification
 */
async function sendSlack(item, config) {
  const { webhookUrl, priorities } = config.slack

  if (!webhookUrl) return false

  // Check priority filter
  const itemPriority = item.priority || 'normal'
  const priorityMap = { urgent: 'critical', high: 'high', medium: 'medium', normal: 'medium', low: 'low' }
  const mappedPriority = priorityMap[itemPriority] || 'medium'
  if (!priorities.includes(mappedPriority) && !priorities.includes(itemPriority)) {
    return true // Skip but don't fail
  }

  const notif = formatNotification(item)
  const color = {
    critical: '#dc2626',
    urgent: '#dc2626',
    high: '#f97316',
    medium: '#eab308',
    normal: '#3b82f6',
    low: '#6b7280'
  }[notif.priority] || '#6b7280'

  try {
    // Convert to proxied URL to avoid CORS
    const proxiedUrl = webhookUrl.replace('https://hooks.slack.com', '/slack-webhook')
    const response = await fetch(proxiedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [
          {
            color,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `${notif.emoji} *${notif.title}*`
                }
              },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: `*Service:*\n${notif.service || 'N/A'}` },
                  { type: 'mrkdwn', text: `*Status:*\n${(notif.status || 'N/A').toUpperCase()}` },
                  { type: 'mrkdwn', text: `*Priority:*\n${notif.priority}` },
                  { type: 'mrkdwn', text: `*Type:*\n${notif.kind}` }
                ]
              },
              {
                type: 'context',
                elements: [
                  { type: 'mrkdwn', text: `Sent from QuoxCore at ${new Date().toLocaleTimeString()}` }
                ]
              }
            ]
          }
        ]
      })
    })

    if (response.ok) {
      clearFailures('slack')
      return true
    }

    recordFailure('slack')
    return false
  } catch {
    recordFailure('slack')
    return false
  }
}

/**
 * Test Email connection
 * @param {object} [smtpConfig] - Deprecated, ignored. The SMTP transport is now resolved
 *   server-side (per-org vault credential, then the instance email config); this parameter
 *   is kept only so existing callers don't break.
 * @param {string} to
 * @param {string} from
 * @param {string} [orgId] - Org ID for multi-org config isolation
 */
export async function testEmail(smtpConfig, to, from, orgId) {
  if (!to) {
    return { success: false, error: 'A recipient email address is required' }
  }

  // Email requires backend proxy - browser cannot do SMTP directly
  // Security Issue #43: Now requires authentication (admin role) + CSRF token
  try {
    const response = await csrfFetch('/api/notifications/test-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        from,
        subject: 'QuoxCore CoreComms Test',
        body: 'This is a test email from QuoxCore CoreComms. If you received this, email notifications are working correctly!'
      })
    })

    if (response.ok) {
      const config = getConfig(orgId)
      config.email.lastTest = Date.now()
      config.email.testStatus = 'success'
      saveConfig(config, orgId)
      clearFailures('email', orgId)
      return { success: true }
    }

    // Check if endpoint doesn't exist (backend not configured)
    if (response.status === 404 || response.status === 405) {
      const config = getConfig(orgId)
      config.email.lastTest = Date.now()
      config.email.testStatus = 'error'
      saveConfig(config, orgId)
      return { success: false, error: 'Email backend not configured. The server needs SMTP endpoints enabled to support email notifications.' }
    }

    // Security Issue #43: Handle auth/authorization errors
    if (response.status === 401) {
      return { success: false, error: 'Authentication required. Please log in to test email.' }
    }
    if (response.status === 403) {
      return { success: false, error: 'Admin role required to test email configuration.' }
    }
    if (response.status === 429) {
      return { success: false, error: 'Rate limit exceeded. Please try again later.' }
    }

    const data = await response.json().catch(() => ({}))
    let errorMessage = data.error || 'Failed to send email'

    if (response.status === 535 || errorMessage.includes('auth')) {
      errorMessage = 'SMTP authentication failed. Check your username and password.'
    } else if (response.status === 503 || errorMessage.includes('connect')) {
      errorMessage = 'Could not connect to mail server. Check host and port.'
    }

    const config = getConfig(orgId)
    config.email.lastTest = Date.now()
    config.email.testStatus = 'error'
    saveConfig(config, orgId)

    return { success: false, error: errorMessage }
  } catch (err) {
    const config = getConfig(orgId)
    config.email.lastTest = Date.now()
    config.email.testStatus = 'error'
    saveConfig(config, orgId)
    return { success: false, error: `Network error: ${err.message}` }
  }
}

/**
 * Send Email notification
 */
async function sendEmail(item, config) {
  const { to, from, priorities } = config.email

  if (!to) return false

  // Check priority filter
  const itemPriority = item.priority || 'normal'
  const priorityMap = { urgent: 'critical', high: 'high', medium: 'medium', normal: 'medium', low: 'low' }
  const mappedPriority = priorityMap[itemPriority] || 'medium'
  if (!priorities.includes(mappedPriority) && !priorities.includes(itemPriority)) {
    return true // Skip but don't fail
  }

  const notif = formatNotification(item)
  const subject = `[QuoxCore] ${notif.emoji} ${notif.title}`
  const body = `
${notif.title}

Service: ${notif.service || 'N/A'}
Status: ${(notif.status || 'N/A').toUpperCase()}
Priority: ${notif.priority}
Type: ${notif.kind}

---
Sent from QuoxCore at ${new Date().toLocaleString()}
`

  try {
    const response = await fetch('/api/notifications/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        from,
        subject,
        body
      })
    })

    if (response.ok) {
      clearFailures('email')
      return true
    }

    recordFailure('email')
    return false
  } catch {
    recordFailure('email')
    return false
  }
}

/**
 * Test a webhook-based channel by POSTing a test message to its URL.
 * Works for: discord, msteams, mattermost, google-chat, rocketchat, ntfy, gotify, webhook.
 *
 * @param {string} channelType
 * @param {object} channelConfig - The channel's config object
 * @param {string} [orgId]
 */
export async function testWebhookChannel(channelType, channelConfig, orgId) {
  // Resolve the URL based on channel type
  let url = channelConfig.webhookUrl || channelConfig.url || ''
  let body, headers = { 'Content-Type': 'application/json' }

  if (channelType === 'ntfy') {
    url = `${(channelConfig.serverUrl || 'https://ntfy.sh').replace(/\/$/, '')}/${channelConfig.topic}`
    if (!channelConfig.topic) return { success: false, error: 'Topic is required' }
  } else if (channelType === 'gotify') {
    url = `${(channelConfig.serverUrl || '').replace(/\/$/, '')}/message?token=${channelConfig.appToken || ''}`
    if (!channelConfig.serverUrl || !channelConfig.appToken) return { success: false, error: 'Server URL and app token are required' }
  }

  if (!url) return { success: false, error: 'URL or webhook URL is required' }

  // Build test payload per channel format
  const testMsg = 'QuoxCore CoreComms connected successfully! You will receive HITL notifications here.'
  switch (channelType) {
    case 'discord':
      body = JSON.stringify({ content: testMsg })
      break
    case 'msteams':
      body = JSON.stringify({
        '@type': 'MessageCard', '@context': 'https://schema.org/extensions',
        summary: 'QuoxCore Test', themeColor: '28a745',
        sections: [{ activityTitle: 'QuoxCore CoreComms Connected', text: testMsg }]
      })
      break
    case 'ntfy':
      body = JSON.stringify({ topic: channelConfig.topic, title: 'QuoxCore Test', message: testMsg, priority: 3 })
      break
    case 'gotify':
      body = JSON.stringify({ title: 'QuoxCore Test', message: testMsg, priority: 5 })
      break
    default:
      body = JSON.stringify({ text: testMsg })
  }

  try {
    const response = await fetch(url, { method: 'POST', headers, body })
    const config = getConfig(orgId)
    if (!config[channelType]) config[channelType] = { ...DEFAULT_CONFIG[channelType] }

    if (response.ok || response.status === 204) {
      config[channelType].lastTest = Date.now()
      config[channelType].testStatus = 'success'
      saveConfig(config, orgId)
      clearFailures(channelType, orgId)
      return { success: true }
    }

    config[channelType].lastTest = Date.now()
    config[channelType].testStatus = 'error'
    saveConfig(config, orgId)
    return { success: false, error: `HTTP ${response.status}: ${response.statusText}` }
  } catch (err) {
    const config = getConfig(orgId)
    if (!config[channelType]) config[channelType] = { ...DEFAULT_CONFIG[channelType] }
    config[channelType].lastTest = Date.now()
    config[channelType].testStatus = 'error'
    saveConfig(config, orgId)
    return { success: false, error: `Network error: ${err.message}` }
  }
}

/**
 * Send notification to all enabled channels
 */
export async function sendNotification(item) {
  if (!isCoreCommsActive()) {
    return { sent: false, reason: 'Plugin not active' }
  }

  const config = getConfig()
  const results = {}
  for (const ch of Object.keys(DEFAULT_CONFIG)) results[ch] = null

  // Send to each enabled channel (in parallel)
  const promises = []

  const addChannel = (ch, sendFn) => {
    if (config[ch]?.enabled && !isInCooldown(ch)) {
      promises.push(
        sendFn(item, config)
          .then(ok => { results[ch] = ok; if (ok) recordCooldown(ch) })
          .catch(() => { results[ch] = false })
      )
    }
  }

  addChannel('telegram', sendTelegram)
  addChannel('slack', sendSlack)
  addChannel('email', sendEmail)

  await Promise.all(promises)

  const sent = Object.values(results).some(r => r === true)
  if (sent) {
    const channels = Object.entries(results).filter(([, v]) => v === true).map(([k]) => k)
    for (const ch of channels) logNotificationSent(ch, item?.priority)
  }
  return { sent, results }
}

/**
 * Get channel status summary
 * @param {string} [orgId] - Org ID for multi-org isolation
 */
// Per-channel logic to determine if a channel has required fields set
const CONFIGURED_CHECKS = {
  telegram: c => !!(c.botToken && c.chatId),
  slack: c => !!c.webhookUrl,
  discord: c => !!c.webhookUrl,
  // EMAIL-UNIFY P2: the transport comes from the instance email setup (or an org vault
  // credential), never from this config, so a recipient is the only thing the org supplies.
  email: c => !!c.to,
  msteams: c => !!c.webhookUrl,
  'twilio-sms': c => !!(c.accountSid && c.fromNumber && c.toNumber),
  pagerduty: c => !!c.routingKey,
  opsgenie: c => !!c.apiKey,
  mattermost: c => !!c.webhookUrl,
  ntfy: c => !!c.topic,
  pushover: c => !!(c.userKey && c.apiToken),
  'google-chat': c => !!c.webhookUrl,
  gotify: c => !!(c.serverUrl && c.appToken),
  rocketchat: c => !!c.webhookUrl,
  line: c => !!c.accessToken,
  webhook: c => !!c.url,
}

export function getChannelStatus(orgId) {
  const config = getConfig(orgId)
  const status = {}

  for (const ch of Object.keys(DEFAULT_CONFIG)) {
    const chConfig = config[ch] || {}
    const isConfigured = CONFIGURED_CHECKS[ch] ? CONFIGURED_CHECKS[ch](chConfig) : false
    status[ch] = {
      enabled: chConfig.enabled || false,
      configured: isConfigured,
      testStatus: chConfig.testStatus || null,
      lastTest: chConfig.lastTest || null,
      failures: getFailureCount(ch, orgId)
    }
  }

  return status
}

// ============================================================================
// Telegram Webhook Management (Inbound Messages)
// ============================================================================

/**
 * Get Telegram webhook status from collector.
 * @returns {Promise<object>} { active, has_token, bot_username, webhook_url, ... }
 */
export async function getTelegramWebhookInfo() {
  try {
    const resp = await fetch('/collector/webhook/telegram/info', { credentials: 'include' })
    if (!resp.ok) return { active: false, has_token: false }
    return resp.json()
  } catch {
    return { active: false, has_token: false, error: 'Failed to fetch webhook info' }
  }
}

/**
 * Register Telegram webhook (admin action).
 * @param {string} webhookUrl - Public HTTPS webhook URL
 * @returns {Promise<object>} result
 */
export async function registerTelegramWebhook(webhookUrl) {
  const resp = await fetch('/collector/webhook/telegram/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ webhook_url: webhookUrl })
  })
  const result = await resp.json()
  logWebhookRegistered('telegram')
  return result
}

/**
 * Deactivate Telegram webhook.
 * @returns {Promise<object>} result
 */
export async function deactivateTelegramWebhook() {
  const resp = await fetch('/collector/webhook/telegram/deactivate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  })
  const result = await resp.json()
  logWebhookDeactivated('telegram')
  return result
}

// ============================================================================
// Slack Webhook Management (Inbound Messages — Events API)
// ============================================================================

/**
 * Get Slack webhook status from collector.
 * @returns {Promise<object>} { active, has_token, bot_username, webhook_url, team }
 */
export async function getSlackWebhookInfo() {
  try {
    const resp = await fetch('/collector/webhook/slack/info', { credentials: 'include' })
    if (!resp.ok) return { active: false, has_token: false }
    return resp.json()
  } catch {
    return { active: false, has_token: false, error: 'Failed to fetch Slack webhook info' }
  }
}

/**
 * Register Slack Events API webhook (admin action).
 * @param {string} webhookUrl - Public HTTPS webhook URL
 * @returns {Promise<object>} result
 */
export async function registerSlackWebhook(webhookUrl) {
  const resp = await fetch('/collector/webhook/slack/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ webhook_url: webhookUrl })
  })
  const result = await resp.json()
  logWebhookRegistered('slack')
  return result
}

/**
 * Deactivate Slack Events API webhook.
 * @returns {Promise<object>} result
 */
export async function deactivateSlackWebhook() {
  const resp = await fetch('/collector/webhook/slack/deactivate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  })
  const result = await resp.json()
  logWebhookDeactivated('slack')
  return result
}

// ============================================================================
// Telegram Multi-Bot Management
// ============================================================================

/**
 * List all Telegram bot credentials from vault.
 * @param {string} orgId - Organization ID
 * @returns {Promise<Array>} List of bot credentials
 */
export async function listTelegramBots(orgId) {
  try {
    const resp = await fetch(`/api/orgs/${orgId}/vault?type=telegram`, {
      credentials: 'include'
    })
    if (!resp.ok) return []
    const data = await resp.json()
    return data.credentials || data.data || data || []
  } catch {
    return []
  }
}

// ============================================================================
// Discord Webhook Management (Inbound Messages — Interactions)
// ============================================================================

/**
 * Get Discord webhook status from collector.
 * @returns {Promise<object>} { active, has_token, bot_username, application_id, interactions_url }
 */
export async function getDiscordWebhookInfo() {
  try {
    const resp = await fetch('/collector/webhook/discord/info', { credentials: 'include' })
    if (!resp.ok) return { active: false, has_token: false }
    return resp.json()
  } catch {
    return { active: false, has_token: false, error: 'Failed to fetch Discord webhook info' }
  }
}

/**
 * Set up Discord bot and register /ask slash command.
 * @param {object} params - { bot_token, public_key, application_id }
 * @returns {Promise<object>} result
 */
export async function registerDiscordWebhook(params) {
  const resp = await fetch('/collector/webhook/discord/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(params)
  })
  const result = await resp.json()
  logWebhookRegistered('discord')
  return result
}

/**
 * Deactivate Discord webhook.
 * @returns {Promise<object>} result
 */
export async function deactivateDiscordWebhook() {
  const resp = await fetch('/collector/webhook/discord/deactivate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  })
  const result = await resp.json()
  logWebhookDeactivated('discord')
  return result
}

// ============================================================================
// Generic Webhook Endpoints CRUD
// ============================================================================

/**
 * List generic webhook endpoints for an org.
 * @param {string} orgId
 * @returns {Promise<Array>}
 */
export async function listWebhookEndpoints(orgId) {
  try {
    const resp = await fetch(`/api/orgs/${orgId}/webhook-endpoints`, { credentials: 'include' })
    if (!resp.ok) return []
    const data = await resp.json()
    return data.endpoints || []
  } catch {
    return []
  }
}

/**
 * Create a generic webhook endpoint.
 * @param {string} orgId
 * @param {object} config - { name, secret, payload_mapping, default_agent }
 * @returns {Promise<object>}
 */
export async function createWebhookEndpoint(orgId, config) {
  const resp = await csrfFetch(`/api/orgs/${orgId}/webhook-endpoints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  })
  const result = await resp.json()
  logEndpointCreated(orgId, result)
  return result
}

/**
 * Update a generic webhook endpoint.
 * @param {string} orgId
 * @param {string} endpointId
 * @param {object} updates
 * @returns {Promise<object>}
 */
export async function updateWebhookEndpoint(orgId, endpointId, updates) {
  const resp = await csrfFetch(`/api/orgs/${orgId}/webhook-endpoints/${endpointId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  })
  const result = await resp.json()
  logEndpointUpdated(orgId, endpointId)
  return result
}

/**
 * Delete a generic webhook endpoint.
 * @param {string} orgId
 * @param {string} endpointId
 * @returns {Promise<object>}
 */
export async function deleteWebhookEndpoint(orgId, endpointId) {
  const resp = await csrfFetch(`/api/orgs/${orgId}/webhook-endpoints/${endpointId}`, {
    method: 'DELETE'
  })
  const result = await resp.json()
  logEndpointDeleted(orgId, endpointId)
  return result
}

/**
 * Migrate localStorage credentials to QuoxVault.
 * Idempotent — safe to call multiple times. Only migrates if localStorage
 * has credentials and vault doesn't already have migrated entries.
 *
 * @param {string} orgId - Organization ID
 * @returns {Promise<{migrated: number, skipped: number, alreadyDone: boolean}>}
 */
export async function migrateToVault(orgId) {
  const migrationKey = `quox_vault_migrated_${orgId}`

  // Check if already migrated
  if (localStorage.getItem(migrationKey) === 'true') {
    return { migrated: 0, skipped: 0, alreadyDone: true }
  }

  const config = getConfig(orgId)
  if (!config) return { migrated: 0, skipped: 0, alreadyDone: false }

  // Build channels payload — only include channels with actual credentials
  const channels = {}
  const channelsWithCreds = ['email', 'telegram', 'slack', 'discord', 'msteams',
    'twilio', 'pagerduty', 'opsgenie', 'pushover', 'gotify', 'ntfy']

  for (const ch of channelsWithCreds) {
    const chConfig = config[ch]
    if (!chConfig) continue

    if (ch === 'email' && chConfig.smtp?.host && chConfig.smtp?.pass) {
      channels.email = { smtp: chConfig.smtp }
    } else if (ch === 'telegram' && chConfig.botToken) {
      channels.telegram = { botToken: chConfig.botToken, chatId: chConfig.chatId }
    } else if ((ch === 'slack' || ch === 'discord' || ch === 'msteams') && chConfig.webhookUrl) {
      channels[ch] = { webhookUrl: chConfig.webhookUrl }
    } else if (ch === 'twilio' && chConfig.authToken) {
      channels.twilio = { accountSid: chConfig.accountSid, authToken: chConfig.authToken, fromNumber: chConfig.fromNumber, toNumber: chConfig.toNumber }
    } else if (ch === 'pagerduty' && chConfig.routingKey) {
      channels.pagerduty = { routingKey: chConfig.routingKey }
    } else if (ch === 'opsgenie' && chConfig.apiKey) {
      channels.opsgenie = { apiKey: chConfig.apiKey, region: chConfig.region }
    } else if (ch === 'pushover' && chConfig.userKey) {
      channels.pushover = { userKey: chConfig.userKey, apiToken: chConfig.apiToken }
    } else if (ch === 'gotify' && chConfig.appToken) {
      channels.gotify = { serverUrl: chConfig.serverUrl, appToken: chConfig.appToken }
    } else if (ch === 'ntfy' && chConfig.topic) {
      channels.ntfy = { serverUrl: chConfig.serverUrl, topic: chConfig.topic }
    }
  }

  // Also check bastion
  let bastion = null
  try {
    const bastionRaw =
      orgGet('bastion-config') ||
      localStorage.getItem(`quox_${orgId}_bastion-config`) ||
      localStorage.getItem('quox-bastion-config') ||
      '{}'
    const bastionConfig = JSON.parse(bastionRaw)
    if (bastionConfig.apiToken) {
      bastion = { apiToken: bastionConfig.apiToken, backendUrl: bastionConfig.backendUrl }
    }
  } catch { /* ignore */ }

  // Skip if nothing to migrate
  if (Object.keys(channels).length === 0 && !bastion) {
    localStorage.setItem(migrationKey, 'true')
    return { migrated: 0, skipped: 0, alreadyDone: false }
  }

  try {
    const resp = await csrfFetch(`/api/orgs/${orgId}/vault/migrate-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels, bastion })
    })

    if (!resp.ok) {
      console.warn('[CoreComms] Migration failed:', resp.status)
      return { migrated: 0, skipped: 0, alreadyDone: false }
    }

    const result = await resp.json()

    // Mark as migrated and strip plaintext secrets from localStorage
    if (result.migrated?.length > 0) {
      localStorage.setItem(migrationKey, 'true')

      // Store credential IDs and strip plaintext secrets for each migrated channel
      const cfg = getConfig(orgId)
      for (const item of result.migrated) {
        const ch = item.channel
        if (!cfg[ch]) continue
        cfg[ch].vault_credential_id = item.credential_id

        // Strip the plaintext secret field — keep non-secret config (to, from, priorities, enabled)
        const secretField = SECRET_FIELDS[ch]
        if (secretField) deleteSecretField(cfg[ch], secretField)
      }
      saveConfig(cfg, orgId)

      // Also strip bastion apiToken from localStorage if bastion was migrated
      if (bastion) {
        try {
          const bastionCfg = JSON.parse(orgGet('bastion-config') || '{}')
          if (bastionCfg.apiToken) {
            delete bastionCfg.apiToken
            orgSet('bastion-config', JSON.stringify(bastionCfg))
          }
        } catch { /* ignore */ }
      }
    }

    return {
      migrated: result.migrated?.length || 0,
      skipped: result.skipped?.length || 0,
      alreadyDone: false
    }
  } catch (err) {
    console.error('[CoreComms] Migration error:', err)
    return { migrated: 0, skipped: 0, alreadyDone: false }
  }
}

export default {
  getConfig,
  saveConfig,
  resetConfig,
  isCoreCommsActive,
  testTelegram,
  testSlack,
  testEmail,
  testWebhookChannel,
  sendNotification,
  getChannelStatus,
  getTelegramWebhookInfo,
  registerTelegramWebhook,
  deactivateTelegramWebhook,
  getSlackWebhookInfo,
  registerSlackWebhook,
  deactivateSlackWebhook,
  listTelegramBots,
  getDiscordWebhookInfo,
  registerDiscordWebhook,
  deactivateDiscordWebhook,
  listWebhookEndpoints,
  createWebhookEndpoint,
  updateWebhookEndpoint,
  deleteWebhookEndpoint,
  migrateToVault,
  PRIORITIES
}
