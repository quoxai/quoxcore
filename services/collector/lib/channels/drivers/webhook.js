/**
 * Generic Webhook Driver — HTTP POST with optional HMAC signing.
 */
const { sendWebhook, hmacSign } = require('../baseDriver');

module.exports = {
  id: 'webhook',
  name: 'Generic Webhook',
  category: 'webhook',
  credentialFields: ['url', 'secret'],
  capabilities: { send: true, receive: true, richContent: false, priority: true },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    const url = credentials?.url || recipient;
    if (!url) return { success: false, error: 'Webhook URL not configured' };

    const payload = {
      event: 'notification',
      title: title || 'Notification',
      message,
      priority: priority || 'normal',
      org_id: orgId,
      timestamp: new Date().toISOString()
    };

    const headers = {};
    if (credentials?.secret) {
      const raw = JSON.stringify(payload);
      headers['X-Signature-256'] = `sha256=${hmacSign(raw, credentials.secret)}`;
    }

    try {
      const result = await sendWebhook(url, payload, { headers });
      if (result.ok) {
        // Redact URL in response to avoid leaking embedded auth tokens
        let safeUrl;
        try { safeUrl = new URL(url).origin + '/...'; } catch { safeUrl = '(endpoint)'; }
        return { success: true, channel: 'webhook', message: `Webhook delivered to ${safeUrl}` };
      }
      return { success: false, error: `Webhook returned ${result.status}: ${result.body}` };
    } catch (err) {
      return { success: false, error: `Webhook failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.url || config.webhook_url || null;
  },

  validateRecipient(recipient) {
    try { new URL(recipient); return true; } catch { return false; }
  }
};
