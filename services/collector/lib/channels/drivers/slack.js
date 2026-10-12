/**
 * Slack Channel Driver — Webhook-based notifications.
 */
const { sendWebhook } = require('../baseDriver');

const PRIORITY_EMOJI = { urgent: ':rotating_light:', high: ':warning:', normal: ':information_source:', low: ':grey_question:' };

module.exports = {
  id: 'slack',
  name: 'Slack',
  category: 'messaging',
  credentialFields: ['webhook'],
  capabilities: { send: true, receive: true, richContent: true, priority: true },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    const webhook = credentials?.webhook || recipient;
    if (!webhook) return { success: false, error: 'Slack webhook URL not configured' };

    const emoji = PRIORITY_EMOJI[priority] || '';
    const text = `${emoji} *${title || 'Notification'}*\n${message}`;

    try {
      const result = await sendWebhook(webhook, { text });
      if (result.ok) return { success: true, channel: 'slack', message: 'Notification sent to Slack' };
      return { success: false, error: `Slack returned ${result.status}: ${result.body}` };
    } catch (err) {
      return { success: false, error: `Slack send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.webhookUrl || config.webhook_url || config.channel || null;
  }
};
