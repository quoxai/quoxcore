/**
 * OpsGenie Driver — Alert API.
 */
const { sendApi } = require('../baseDriver');

const PRIORITY_MAP = { urgent: 'P1', high: 'P2', normal: 'P3', low: 'P4' };

module.exports = {
  id: 'opsgenie',
  name: 'OpsGenie',
  category: 'incident',
  credentialFields: ['api_key'],
  capabilities: { send: true, receive: false, richContent: false, priority: true },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    const apiKey = credentials?.api_key;
    if (!apiKey) return { success: false, error: 'OpsGenie API key not configured' };

    try {
      const result = await sendApi(
        'https://api.opsgenie.com', '/v2/alerts',
        {
          message: title || 'Quox Notification',
          description: message,
          priority: PRIORITY_MAP[priority] || 'P3',
          source: `quox-${orgId || 'default'}`,
          tags: ['quox', priority || 'normal']
        },
        { type: 'bearer', token: apiKey }
      );
      if (result.ok) return { success: true, channel: 'opsgenie', message: 'OpsGenie alert created' };
      return { success: false, error: `OpsGenie returned ${result.status}: ${JSON.stringify(result.data)}` };
    } catch (err) {
      return { success: false, error: `OpsGenie send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    // Don't return api_key as recipient (credential leak risk)
    return config.team || config.alias || config.responder || 'opsgenie-alert';
  }
};
