/**
 * Google Chat Driver — Incoming webhook with Card V2.
 */
const { sendWebhook } = require('../baseDriver');

module.exports = {
  id: 'google-chat',
  name: 'Google Chat',
  category: 'messaging',
  credentialFields: ['webhook_url'],
  capabilities: { send: true, receive: false, richContent: true, priority: true },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    const webhookUrl = credentials?.webhook_url || recipient;
    if (!webhookUrl) return { success: false, error: 'Google Chat webhook URL not configured' };

    const priorityEmoji = { urgent: '\u{1F6A8}', high: '\u26A0\uFE0F', normal: '\u2139\uFE0F', low: '\u{1F4AC}' };
    const emoji = priorityEmoji[priority] || '';

    const payload = {
      cardsV2: [{
        cardId: `quox-${Date.now()}`,
        card: {
          header: {
            title: `${emoji} ${title || 'Notification'}`,
            subtitle: `Priority: ${priority || 'normal'}`
          },
          sections: [{
            widgets: [
              { textParagraph: { text: message } },
              {
                decoratedText: {
                  topLabel: 'Source',
                  text: 'QuoxCORE',
                  startIcon: { knownIcon: 'CLOCK' }
                }
              }
            ]
          }]
        }
      }]
    };

    try {
      const result = await sendWebhook(webhookUrl, payload);
      if (result.ok) return { success: true, channel: 'google-chat', message: 'Sent to Google Chat' };
      return { success: false, error: `Google Chat returned ${result.status}: ${result.body}` };
    } catch (err) {
      return { success: false, error: `Google Chat send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.webhook_url || config.webhookUrl || null;
  },

  validateRecipient(recipient) {
    return typeof recipient === 'string' && recipient.startsWith('https://chat.googleapis.com/');
  }
};
