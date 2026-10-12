/**
 * Gotify Driver — Self-hosted push notification server.
 * Uses REST API with app token authentication.
 */

module.exports = {
  id: 'gotify',
  name: 'Gotify',
  category: 'push',
  credentialFields: ['server_url', 'app_token'],
  capabilities: { send: true, receive: false, richContent: false, priority: true },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    const serverUrl = credentials?.server_url;
    const appToken = credentials?.app_token;
    if (!serverUrl) return { success: false, error: 'Gotify server URL not configured' };
    if (!appToken) return { success: false, error: 'Gotify app token not configured' };

    // Gotify priorities: 0 = min, 4 = normal, 7 = high, 10 = max
    const gotifyPriority = { urgent: 10, high: 7, normal: 4, low: 1 };

    try {
      const url = `${serverUrl.replace(/\/$/, '')}/message?token=${appToken}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title || 'Quox Notification',
          message,
          priority: gotifyPriority[priority] || 4
        }),
        signal: AbortSignal.timeout(10000)
      });

      if (resp.ok) return { success: true, channel: 'gotify', message: 'Sent to Gotify' };
      const body = await resp.text();
      return { success: false, error: `Gotify returned ${resp.status}: ${body}` };
    } catch (err) {
      return { success: false, error: `Gotify send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.server_url || config.serverUrl || null;
  }
};
