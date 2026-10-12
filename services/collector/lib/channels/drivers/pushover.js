/**
 * Pushover Driver — HTTP POST for push notifications.
 */

module.exports = {
  id: 'pushover',
  name: 'Pushover',
  category: 'push',
  credentialFields: ['app_token', 'user_key'],
  capabilities: { send: true, receive: false, richContent: false, priority: true },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    const appToken = credentials?.app_token;
    const userKey = credentials?.user_key || recipient;
    if (!appToken) return { success: false, error: 'Pushover app token not configured' };
    if (!userKey) return { success: false, error: 'Pushover user key not provided' };

    const pushoverPriority = { urgent: 2, high: 1, normal: 0, low: -1 };
    const pri = pushoverPriority[priority] ?? 0;

    const body = new URLSearchParams({
      token: appToken,
      user: userKey,
      title: (title || 'Quox Notification').slice(0, 250),
      message: (message || '').slice(0, 1024),
      priority: pri.toString(),
      ...(pri === 2 ? { retry: '60', expire: '3600' } : {})
    });

    try {
      const resp = await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(10000)
      });

      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.status === 1) return { success: true, channel: 'pushover', message: 'Pushover notification sent' };
      return { success: false, error: data.errors?.[0] || `Pushover returned ${resp.status}` };
    } catch (err) {
      return { success: false, error: `Pushover send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.user_key || config.userKey || null;
  }
};
