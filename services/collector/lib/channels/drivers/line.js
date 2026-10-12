/**
 * LINE Notify Driver — LINE Messaging via Notify API.
 * Simple token-based API for sending notifications to LINE groups/users.
 *
 * DEPRECATED / UNSUPPORTED: LINE Notify (notify-api.line.me) was shut down
 * by LINE on 2025-03-31. This driver will fail every send — there is no
 * working credential to configure. Kept registered (not deleted) so the
 * channel_type value and any historical config remain valid, but it should
 * not be offered to users as a working option. A LINE Messaging API
 * driver would need to replace this if LINE support is wanted again.
 */

module.exports = {
  id: 'line',
  name: 'LINE Notify (deprecated — LINE Notify shut down 2025-03-31, unsupported)',
  category: 'messaging',
  credentialFields: ['access_token'],
  capabilities: { send: true, receive: false, richContent: false, priority: false },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    const accessToken = credentials?.access_token;
    if (!accessToken) return { success: false, error: 'LINE Notify access token not configured' };

    const fullMessage = title ? `\n${title}\n${message}` : `\n${message}`;

    // LINE Notify uses application/x-www-form-urlencoded
    try {
      const resp = await fetch('https://notify-api.line.me/api/notify', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ message: fullMessage }).toString(),
        signal: AbortSignal.timeout(10000)
      });

      if (resp.ok) return { success: true, channel: 'line', message: 'Sent to LINE Notify' };
      let errMsg;
      try { const data = await resp.json(); errMsg = data.message; } catch { errMsg = `HTTP ${resp.status}`; }
      return { success: false, error: `LINE Notify returned: ${errMsg}` };
    } catch (err) {
      return { success: false, error: `LINE Notify send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    // LINE Notify doesn't have a "recipient" — the token determines the target
    return config.access_token ? 'line-notify' : null;
  }
};
