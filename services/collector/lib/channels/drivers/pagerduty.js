/**
 * PagerDuty Driver — Events API v2 (routing key).
 */
const { sendApi } = require('../baseDriver');

const SEVERITY_MAP = { urgent: 'critical', high: 'error', normal: 'warning', low: 'info' };

module.exports = {
  id: 'pagerduty',
  name: 'PagerDuty',
  category: 'incident',
  credentialFields: ['routing_key'],
  capabilities: { send: true, receive: false, richContent: false, priority: true },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    const routingKey = credentials?.routing_key || recipient;
    if (!routingKey) return { success: false, error: 'PagerDuty routing key not configured' };

    const payload = {
      routing_key: routingKey,
      event_action: 'trigger',
      payload: {
        summary: title || 'Quox Notification',
        severity: SEVERITY_MAP[priority] || 'warning',
        source: `quox-${orgId || 'default'}`,
        component: 'quoxcore',
        custom_details: { message, priority, timestamp: new Date().toISOString() }
      }
    };

    try {
      const result = await sendApi('https://events.pagerduty.com', '/v2/enqueue', payload);
      if (result.ok) return { success: true, channel: 'pagerduty', message: 'PagerDuty event triggered' };
      return { success: false, error: `PagerDuty returned ${result.status}: ${JSON.stringify(result.data)}` };
    } catch (err) {
      return { success: false, error: `PagerDuty send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.routing_key || config.routingKey || null;
  }
};
