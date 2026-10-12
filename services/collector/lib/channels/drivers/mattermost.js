/**
 * Mattermost Driver — Incoming webhook.
 */
const { sendWebhook } = require('../baseDriver');

module.exports = {
  id: 'mattermost',
  name: 'Mattermost',
  category: 'messaging',
  credentialFields: ['webhook_url'],
  capabilities: { send: true, receive: false, richContent: true, priority: true },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    const webhookUrl = credentials?.webhook_url || recipient;
    if (!webhookUrl) return { success: false, error: 'Mattermost webhook URL not configured' };

    const text = `**${title || 'Notification'}**\n${message}\n_Priority: ${priority || 'normal'}_`;

    try {
      const result = await sendWebhook(webhookUrl, { text });
      if (result.ok) return { success: true, channel: 'mattermost', message: 'Sent to Mattermost' };
      return { success: false, error: `Mattermost returned ${result.status}: ${result.body}` };
    } catch (err) {
      return { success: false, error: `Mattermost send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.webhook_url || config.webhookUrl || null;
  }
};
