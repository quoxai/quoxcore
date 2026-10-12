/**
 * Discord Channel Driver — Webhook with embeds.
 */
const { sendWebhook } = require('../baseDriver');

const COLOR_MAP = { urgent: 0xFF0000, high: 0xFF8C00, normal: 0x3498DB, low: 0x95A5A6 };

module.exports = {
  id: 'discord',
  name: 'Discord',
  category: 'messaging',
  credentialFields: ['webhook'],
  capabilities: { send: true, receive: true, richContent: true, priority: true },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    const webhook = credentials?.webhook || recipient;
    if (!webhook || (!webhook.startsWith('https://discord.com/api/webhooks/') && !webhook.startsWith('https://discordapp.com/api/webhooks/'))) {
      return { success: false, error: 'Discord webhook URL not configured or invalid' };
    }

    try {
      const result = await sendWebhook(webhook, {
        embeds: [{
          title: title || 'Notification',
          description: message,
          color: COLOR_MAP[priority] || COLOR_MAP.normal,
          timestamp: new Date().toISOString()
        }]
      });
      if (result.ok) return { success: true, channel: 'discord', message: 'Sent to Discord' };
      return { success: false, error: `Discord returned ${result.status}: ${result.body}` };
    } catch (err) {
      return { success: false, error: `Discord send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.webhookUrl || config.webhook_url || config.webhook || null;
  }
};
