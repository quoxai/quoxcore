/**
 * Telegram Bot Setup Utility
 *
 * Functions to register the webhook URL with Telegram Bot API,
 * set bot commands, and query webhook status.
 * Called from the admin /webhook/telegram/setup endpoint.
 */

/**
 * Register webhook URL with Telegram Bot API.
 * @param {string} botToken - Bot API token
 * @param {string} webhookUrl - Public HTTPS URL for incoming updates
 * @param {string} [secret] - Secret token for X-Telegram-Bot-Api-Secret-Token validation
 * @returns {Promise<object>} Telegram API response
 */
async function registerWebhook(botToken, webhookUrl, secret) {
  const body = {
    url: webhookUrl,
    allowed_updates: ['message', 'edited_message'],
    drop_pending_updates: false
  };

  if (secret) {
    body.secret_token = secret;
  }

  const resp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });

  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`setWebhook failed: ${data.description || 'Unknown error'}`);
  }

  console.log(`[Telegram Setup] Webhook registered: ${webhookUrl}`);
  return data;
}

/**
 * Register bot commands with Telegram.
 * @param {string} botToken - Bot API token
 * @returns {Promise<object>} Telegram API response
 */
async function setCommands(botToken) {
  const commands = [
    { command: 'start', description: 'Welcome message' },
    { command: 'help', description: 'Show available commands' },
    { command: 'status', description: 'Check connection status' }
  ];

  const resp = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
    signal: AbortSignal.timeout(10000)
  });

  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`setMyCommands failed: ${data.description || 'Unknown error'}`);
  }

  console.log('[Telegram Setup] Bot commands registered');
  return data;
}

/**
 * Get current webhook configuration from Telegram.
 * @param {string} botToken - Bot API token
 * @returns {Promise<object>} Webhook info
 */
async function getWebhookInfo(botToken) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
    signal: AbortSignal.timeout(10000)
  });

  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`getWebhookInfo failed: ${data.description || 'Unknown error'}`);
  }

  return data.result;
}

/**
 * Get bot info (username, name) from Telegram.
 * @param {string} botToken - Bot API token
 * @returns {Promise<object>} Bot info ({ id, is_bot, first_name, username })
 */
async function getBotInfo(botToken) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
    signal: AbortSignal.timeout(10000)
  });

  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`getMe failed: ${data.description || 'Unknown error'}`);
  }

  return data.result;
}

module.exports = { registerWebhook, setCommands, getWebhookInfo, getBotInfo };
