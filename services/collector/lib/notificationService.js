/**
 * Native Notification Service — Thin Wrapper
 *
 * Delegates to the channel driver registry for all dispatching.
 * Legacy function exports (sendTelegram, sendSlack, etc.) preserved
 * for backward compatibility.
 *
 * Credential resolution: QuoxVault → env vars (waterfall)
 */

const channels = require('./channels');
const { buildInternalServiceHeaders } = require('./internalServiceHeaders.js');

// Env var defaults (last-resort fallback)
const ENV_SLACK_WEBHOOK = process.env.NOTIFICATION_SLACK_WEBHOOK || '';
const ENV_TELEGRAM_TOKEN = process.env.NOTIFICATION_TELEGRAM_TOKEN || '';
const ENV_DISCORD_WEBHOOK = process.env.NOTIFICATION_DISCORD_WEBHOOK || '';
const ENV_SMTP_HOST = process.env.NOTIFICATION_SMTP_HOST || '';
const ENV_SMTP_PORT = parseInt(process.env.NOTIFICATION_SMTP_PORT || '587');
const ENV_SMTP_USER = process.env.NOTIFICATION_SMTP_USER || '';
const ENV_SMTP_PASS = process.env.NOTIFICATION_SMTP_PASS || '';
const ENV_SMTP_FROM = process.env.NOTIFICATION_SMTP_FROM || 'quox@example.com';

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;

// Vault credential cache (30s TTL, keyed by orgId:channel)
let _vaultCreds = {};
let _vaultCredsTime = {};
const VAULT_CACHE_TTL = 30_000;

// EMAIL-UNIFY: instance SMTP cache (30s TTL, instance-wide — not org-keyed,
// since there is exactly one instance transport). Sourced from the auth
// internal endpoint that reads the same instance_config smtp_* rows the
// Settings email panel writes. Cached only on a configured result (mirrors
// getClaudeKeys' vault-cache pattern in server.js) so an unconfigured
// instance doesn't wedge a stale negative result.
let _instanceSmtpCache = null;
let _instanceSmtpCacheTime = 0;
const INSTANCE_SMTP_CACHE_TTL = 30_000;

/**
 * Resolve the instance-wide SMTP transport from auth's internal endpoint
 * (the same config powering sign-in verification, password reset,
 * invitations, and QuoxChat transcripts). Returns null if unset or
 * unreachable — callers fall through to the env var fallback.
 */
async function getInstanceSmtpConfig() {
  const now = Date.now();
  if (_instanceSmtpCache && (now - _instanceSmtpCacheTime) < INSTANCE_SMTP_CACHE_TTL) {
    return _instanceSmtpCache;
  }

  try {
    const resp = await fetch(`${AUTH_BASE_URL}/api/setup/internal/smtp-config`, {
      headers: buildInternalServiceHeaders(),
      signal: AbortSignal.timeout(3000)
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data?.configured) {
        const result = { host: data.host, port: data.port, user: data.user, pass: data.pass, from: data.from };
        _instanceSmtpCache = result;
        _instanceSmtpCacheTime = now;
        return result;
      }
    }
  } catch {
    // Fall through to env fallback
  }
  return null;
}

/**
 * Resolve notification credentials from vault, fall back to env vars.
 * @param {string} channel - Channel type (slack, telegram, smtp, discord, etc.)
 * @param {string} [orgId='default'] - Org ID for multi-org credential isolation
 */
async function resolveNotifCreds(channel, orgId = 'default') {
  const cacheKey = `${orgId}:${channel}`;
  const now = Date.now();
  if (_vaultCreds[cacheKey] && (now - (_vaultCredsTime[cacheKey] || 0)) < VAULT_CACHE_TTL) {
    return _vaultCreds[cacheKey];
  }

  // Try vault resolution
  try {
    const resp = await fetch(`${AUTH_BASE_URL}/api/setup/internal/resolve`, {
      method: 'POST',
      headers: buildInternalServiceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ org_id: orgId, channels: [channel] }),
      signal: AbortSignal.timeout(3000)
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.channels?.[channel]?.credentials) {
        _vaultCreds[cacheKey] = data.channels[channel].credentials;
        _vaultCredsTime[cacheKey] = now;
        return _vaultCreds[cacheKey];
      }
    }
  } catch {
    // Fall through to env vars
  }
  return null;
}

/**
 * Resolve credentials for a channel, combining vault + env fallbacks.
 * Returns a flat object the driver can consume.
 */
async function resolveCredentialsForChannel(channel, orgId) {
  const vaultCreds = await resolveNotifCreds(channel === 'email' ? 'smtp' : channel, orgId);
  if (vaultCreds) return vaultCreds;

  // Env var fallbacks. Slack/telegram/discord/email are the original
  // (legacy) entries; the rest mirror the NOTIFICATION_ENV_MAP env var
  // naming convention in services/auth/services/credentialResolver.js so
  // the two fallback paths stay in sync.
  switch (channel) {
    case 'slack':
      return ENV_SLACK_WEBHOOK ? { webhook: ENV_SLACK_WEBHOOK } : null;
    case 'telegram':
      return ENV_TELEGRAM_TOKEN ? { token: ENV_TELEGRAM_TOKEN } : null;
    case 'discord':
      return ENV_DISCORD_WEBHOOK ? { webhook: ENV_DISCORD_WEBHOOK } : null;
    case 'email': {
      // EMAIL-UNIFY priority: per-org vault override (checked above via
      // resolveNotifCreds) -> instance SMTP from the auth panel config (NEW)
      // -> NOTIFICATION_SMTP_* env as a last-resort fallback.
      const instanceSmtp = await getInstanceSmtpConfig();
      if (instanceSmtp) return instanceSmtp;
      return ENV_SMTP_HOST ? { host: ENV_SMTP_HOST, port: ENV_SMTP_PORT, user: ENV_SMTP_USER, pass: ENV_SMTP_PASS, from: ENV_SMTP_FROM } : null;
    }
    case 'msteams': {
      const webhook_url = process.env.NOTIFICATION_MSTEAMS_WEBHOOK || '';
      return webhook_url ? { webhook_url } : null;
    }
    case 'twilio-sms': {
      const account_sid = process.env.NOTIFICATION_TWILIO_ACCOUNT_SID || '';
      const auth_token = process.env.NOTIFICATION_TWILIO_AUTH_TOKEN || '';
      const from_number = process.env.NOTIFICATION_TWILIO_FROM_NUMBER || '';
      return (account_sid || auth_token || from_number) ? { account_sid, auth_token, from_number } : null;
    }
    case 'pagerduty': {
      const routing_key = process.env.NOTIFICATION_PAGERDUTY_ROUTING_KEY || '';
      return routing_key ? { routing_key } : null;
    }
    case 'opsgenie': {
      const api_key = process.env.NOTIFICATION_OPSGENIE_API_KEY || '';
      return api_key ? { api_key } : null;
    }
    case 'mattermost': {
      const webhook_url = process.env.NOTIFICATION_MATTERMOST_WEBHOOK || '';
      return webhook_url ? { webhook_url } : null;
    }
    case 'ntfy': {
      const server_url = process.env.NOTIFICATION_NTFY_SERVER || '';
      const topic = process.env.NOTIFICATION_NTFY_TOPIC || '';
      return (server_url || topic) ? { server_url, topic } : null;
    }
    case 'pushover': {
      const app_token = process.env.NOTIFICATION_PUSHOVER_APP_TOKEN || '';
      const user_key = process.env.NOTIFICATION_PUSHOVER_USER_KEY || '';
      return (app_token || user_key) ? { app_token, user_key } : null;
    }
    case 'webhook': {
      const url = process.env.NOTIFICATION_WEBHOOK_URL || '';
      const secret = process.env.NOTIFICATION_WEBHOOK_SECRET || '';
      return url ? { url, secret } : null;
    }
    case 'google-chat': {
      const webhook_url = process.env.NOTIFICATION_GOOGLE_CHAT_WEBHOOK || '';
      return webhook_url ? { webhook_url } : null;
    }
    case 'gotify': {
      const server_url = process.env.NOTIFICATION_GOTIFY_SERVER || '';
      const app_token = process.env.NOTIFICATION_GOTIFY_APP_TOKEN || '';
      return (server_url || app_token) ? { server_url, app_token } : null;
    }
    case 'rocketchat': {
      const webhook_url = process.env.NOTIFICATION_ROCKETCHAT_WEBHOOK || '';
      return webhook_url ? { webhook_url } : null;
    }
    case 'line': {
      const access_token = process.env.NOTIFICATION_LINE_ACCESS_TOKEN || '';
      return access_token ? { access_token } : null;
    }
    default:
      return null;
  }
}

/**
 * Send a notification through a registered channel driver.
 * Resolves credentials automatically, then delegates to the registry.
 *
 * @param {object} input - { channel, recipient, title, message, priority, orgId, credentials? }
 *   input.credentials (optional): per-call credential override. When set,
 *   vault/env resolution is skipped entirely — QUOXCHAT-PRO uses this to
 *   deliver per-widget webhook URLs (the webhook driver prefers
 *   credentials.url over recipient, so a globally configured
 *   NOTIFICATION_WEBHOOK_URL would otherwise hijack every widget alert).
 * @returns {Promise<object>} - { success, channel, message?, error? }
 */
async function sendNotification(input) {
  const { channel, recipient, title, message, priority, orgId, attachments, html, credentials: credentialsOverride } = input;

  // Resolve credentials from vault/env unless the caller supplied them.
  const credentials = credentialsOverride || await resolveCredentialsForChannel(channel, orgId);

  // Delegate to the channel driver registry. `attachments` and `html` (both
  // optional) are forwarded verbatim; drivers that support them (email) use
  // them, others ignore. `message` stays the plain-text body/fallback.
  return channels.sendNotification({
    channel,
    recipient,
    title,
    message,
    priority,
    orgId,
    attachments,
    html,
    credentials
  });
}

// ─── Legacy Convenience Exports ────────────────────────────────────────────
// Preserved for backward compatibility. New code should use sendNotification().

async function sendSlack(channel, title, message, priority, orgId) {
  const credentials = await resolveCredentialsForChannel('slack', orgId);
  return channels.sendNotification({ channel: 'slack', recipient: channel, title, message, priority, orgId, credentials });
}

async function sendTelegram(chatId, title, message, orgId, opts = {}) {
  const credentials = await resolveCredentialsForChannel('telegram', orgId);
  const { threadKey, parseMode } = opts;
  return channels.sendNotification({
    channel: 'telegram',
    recipient: chatId,
    title,
    message,
    priority: 'normal',
    orgId,
    credentials,
    threadKey,
    parseMode
  });
}

async function sendEmail(recipient, title, message, priority, orgId) {
  const credentials = await resolveCredentialsForChannel('email', orgId);
  return channels.sendNotification({ channel: 'email', recipient, title, message, priority, orgId, credentials });
}

async function sendDiscord(webhookOrChannel, title, message, priority, orgId) {
  const credentials = await resolveCredentialsForChannel('discord', orgId);
  return channels.sendNotification({ channel: 'discord', recipient: webhookOrChannel, title, message, priority, orgId, credentials });
}

// Test-only: clear the instance SMTP cache (module-level state persists
// across tests in the same file, mirroring the vault cache's cross-test
// bleed risk already called out in notificationServiceMultiOrg.test.js).
function _resetInstanceSmtpCacheForTests() {
  _instanceSmtpCache = null;
  _instanceSmtpCacheTime = 0;
}

module.exports = { sendNotification, sendTelegram, sendSlack, sendEmail, sendDiscord, resolveNotifCreds, _resetInstanceSmtpCacheForTests };
