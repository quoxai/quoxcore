/**
 * Microsoft Teams Driver — Incoming webhook with Adaptive Cards.
 */
const { sendWebhook } = require('../baseDriver');

const PRIORITY_COLORS = { urgent: 'attention', high: 'warning', normal: 'accent', low: 'default' };

module.exports = {
  id: 'msteams',
  name: 'Microsoft Teams',
  category: 'messaging',
  credentialFields: ['webhook_url'],
  capabilities: { send: true, receive: false, richContent: true, priority: true },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    const webhookUrl = credentials?.webhook_url || recipient;
    if (!webhookUrl) return { success: false, error: 'Teams webhook URL not configured' };

    const card = {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: title || 'Notification',
              weight: 'bolder',
              size: 'medium',
              color: PRIORITY_COLORS[priority] || 'default'
            },
            { type: 'TextBlock', text: message, wrap: true },
            {
              type: 'FactSet',
              facts: [
                { title: 'Priority', value: priority || 'normal' },
                { title: 'Time', value: new Date().toLocaleString() }
              ]
            }
          ]
        }
      }]
    };

    try {
      const result = await sendWebhook(webhookUrl, card);
      if (result.ok) return { success: true, channel: 'msteams', message: 'Sent to Microsoft Teams' };
      return { success: false, error: `Teams returned ${result.status}: ${result.body}` };
    } catch (err) {
      return { success: false, error: `Teams send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.webhook_url || config.webhookUrl || null;
  }
};
