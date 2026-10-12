/**
 * Discord Bot API Utilities
 *
 * Verifies bot tokens, validates Ed25519 interaction signatures,
 * and sends channel messages via Discord REST API v10.
 */
const crypto = require('crypto');

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Verify a Discord bot token by calling /users/@me.
 * @param {string} botToken
 * @returns {Promise<{ok: boolean, username?: string, discriminator?: string, id?: string, error?: string}>}
 */
async function verifyBotToken(botToken) {
  try {
    const resp = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(10000)
    });
    if (resp.ok) {
      const data = await resp.json();
      return { ok: true, username: data.username, discriminator: data.discriminator, id: data.id };
    }
    return { ok: false, error: `Discord returned ${resp.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Validate Discord interaction signature (Ed25519).
 *
 * Discord sends:
 *   X-Signature-Ed25519: hex-encoded Ed25519 signature
 *   X-Signature-Timestamp: Unix timestamp string
 *
 * The signed message is `timestamp + body`.
 *
 * @param {string} publicKey - hex-encoded Ed25519 public key from Discord app settings
 * @param {string} timestamp - X-Signature-Timestamp header
 * @param {string} rawBody - raw request body string
 * @param {string} signature - X-Signature-Ed25519 header (hex)
 * @returns {boolean}
 */
function validateInteractionSignature(publicKey, timestamp, rawBody, signature) {
  if (!publicKey || !timestamp || !rawBody || !signature) return false;

  try {
    const message = Buffer.from(timestamp + rawBody);
    const sig = Buffer.from(signature, 'hex');
    const key = Buffer.from(publicKey, 'hex');

    // Node 18+ supports Ed25519 via crypto.verify
    const pubKey = crypto.createPublicKey({
      key: Buffer.concat([
        // Ed25519 DER prefix for public key (ASN.1 header)
        Buffer.from('302a300506032b6570032100', 'hex'),
        key
      ]),
      format: 'der',
      type: 'spki'
    });
    return crypto.verify(null, message, pubKey, sig);
  } catch {
    return false;
  }
}

/**
 * Send a message to a Discord channel.
 * @param {string} botToken
 * @param {string} channelId
 * @param {string} content - message text
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function sendChannelMessage(botToken, channelId, content) {
  try {
    const resp = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(10000)
    });
    if (resp.ok) return { ok: true };
    const body = await resp.text();
    return { ok: false, error: `Discord ${resp.status}: ${body.substring(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Register a global slash command on the Discord application.
 * @param {string} botToken
 * @param {string} applicationId
 * @param {object} command - { name, description, type, options }
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function registerSlashCommand(botToken, applicationId, command) {
  try {
    const resp = await fetch(`${DISCORD_API}/applications/${applicationId}/commands`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(10000)
    });
    if (resp.ok) return { ok: true };
    const body = await resp.text();
    return { ok: false, error: `Discord ${resp.status}: ${body.substring(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send an interaction response (for slash commands / interactions).
 * @param {string} interactionId
 * @param {string} interactionToken
 * @param {string} content
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function sendInteractionResponse(interactionId, interactionToken, content) {
  try {
    const resp = await fetch(`${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
        data: { content }
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (resp.ok || resp.status === 204) return { ok: true };
    const body = await resp.text();
    return { ok: false, error: `Discord ${resp.status}: ${body.substring(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send a deferred interaction response (type 5 — "thinking...").
 * Follow up with editOriginalInteractionResponse().
 */
async function deferInteractionResponse(interactionId, interactionToken) {
  try {
    const resp = await fetch(`${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 5 }), // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      signal: AbortSignal.timeout(10000)
    });
    return { ok: resp.ok || resp.status === 204 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Edit the original interaction response (after deferring).
 */
async function editOriginalInteractionResponse(applicationId, interactionToken, content) {
  try {
    const resp = await fetch(`${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(10000)
    });
    return { ok: resp.ok };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  verifyBotToken,
  validateInteractionSignature,
  sendChannelMessage,
  registerSlashCommand,
  sendInteractionResponse,
  deferInteractionResponse,
  editOriginalInteractionResponse
};
