/**
 * Slack Bot Setup Utility
 *
 * Functions to verify bot token, query bot info, and validate
 * Slack Events API request signatures.
 * Called from the admin /webhook/slack/setup endpoint.
 */

const { createHmac, timingSafeEqual } = require('crypto');

/**
 * Verify Slack bot token by calling auth.test.
 * @param {string} botToken - Slack bot token (xoxb-...)
 * @returns {Promise<object>} { ok, team, user, bot_id, ... }
 */
async function verifyBotToken(botToken) {
  const resp = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    signal: AbortSignal.timeout(10000)
  });

  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`auth.test failed: ${data.error || 'Unknown error'}`);
  }

  console.log(`[Slack Setup] Bot verified: @${data.user} in ${data.team}`);
  return data;
}

/**
 * Validate Slack request signature (HMAC-SHA256).
 * @param {string} signingSecret - Slack app signing secret
 * @param {string} timestamp - X-Slack-Request-Timestamp header
 * @param {string} rawBody - Raw request body string
 * @param {string} signature - X-Slack-Signature header (v0=...)
 * @returns {boolean} Whether signature is valid
 */
function validateSignature(signingSecret, timestamp, rawBody, signature) {
  // Replay protection: reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    return false;
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expectedSig = 'v0=' + createHmac('sha256', signingSecret)
    .update(baseString)
    .digest('hex');

  try {
    return timingSafeEqual(
      Buffer.from(expectedSig, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
  } catch {
    return false;
  }
}

/**
 * Send a message to a Slack channel via chat.postMessage.
 * @param {string} botToken - Slack bot token
 * @param {string} channel - Channel ID or user ID
 * @param {string} text - Message text
 * @returns {Promise<object>} Slack API response
 */
async function postMessage(botToken, channel, text) {
  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ channel, text }),
    signal: AbortSignal.timeout(10000)
  });

  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`chat.postMessage failed: ${data.error || 'Unknown error'}`);
  }

  return data;
}

module.exports = { verifyBotToken, validateSignature, postMessage };
