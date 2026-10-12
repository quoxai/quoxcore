/**
 * ntfy Driver — Simple HTTP POST to topic.
 */

module.exports = {
  id: 'ntfy',
  name: 'ntfy',
  category: 'push',
  credentialFields: ['server_url', 'topic'],
  capabilities: { send: true, receive: false, richContent: false, priority: true },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    const server = credentials?.server_url || 'https://ntfy.sh';
    const topic = credentials?.topic || recipient;
    if (!topic) return { success: false, error: 'ntfy topic not configured' };

    const ntfyPriority = { urgent: '5', high: '4', normal: '3', low: '2' };

    try {
      const resp = await fetch(`${server}/${topic}`, {
        method: 'POST',
        headers: {
          'Title': title || 'Quox Notification',
          'Priority': ntfyPriority[priority] || '3',
          'Tags': 'quox'
        },
        body: message,
        signal: AbortSignal.timeout(10000)
      });

      if (resp.ok) return { success: true, channel: 'ntfy', message: `Sent to ntfy topic ${topic}` };
      const body = await resp.text();
      return { success: false, error: `ntfy returned ${resp.status}: ${body}` };
    } catch (err) {
      return { success: false, error: `ntfy send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.topic || null;
  }
};
