/**
 * Rocket.Chat Driver — Incoming webhook integration.
 */
const { sendWebhook } = require('../baseDriver');

module.exports = {
  id: 'rocketchat',
  name: 'Rocket.Chat',
  category: 'messaging',
  credentialFields: ['webhook_url'],
  capabilities: { send: true, receive: false, richContent: true, priority: true },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    const webhookUrl = credentials?.webhook_url || recipient;
    if (!webhookUrl) return { success: false, error: 'Rocket.Chat webhook URL not configured' };

    const priorityColor = { urgent: '#ff0000', high: '#ff8800', normal: '#0088ff', low: '#888888' };

    const payload = {
      text: title ? `*${title}*` : undefined,
      attachments: [{
        color: priorityColor[priority] || '#0088ff',
        title: title || 'Notification',
        text: message,
        fields: [
          { short: true, title: 'Priority', value: priority || 'normal' },
          { short: true, title: 'Source', value: 'QuoxCORE' }
        ],
        ts: new Date().toISOString()
      }]
    };

    // Add channel override if recipient looks like a channel name
    if (recipient && recipient.startsWith('#')) {
      payload.channel = recipient;
    }

    try {
      const result = await sendWebhook(webhookUrl, payload);
      if (result.ok) return { success: true, channel: 'rocketchat', message: 'Sent to Rocket.Chat' };
      return { success: false, error: `Rocket.Chat returned ${result.status}: ${result.body}` };
    } catch (err) {
      return { success: false, error: `Rocket.Chat send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.webhook_url || config.webhookUrl || config.channel || null;
  }
};
