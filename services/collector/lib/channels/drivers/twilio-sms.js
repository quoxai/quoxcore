/**
 * Twilio SMS Driver — SMS via Twilio Messages API.
 */
const { sendApi } = require('../baseDriver');

module.exports = {
  id: 'twilio-sms',
  name: 'SMS (Twilio)',
  category: 'sms',
  credentialFields: ['account_sid', 'auth_token', 'from_number'],
  capabilities: { send: true, receive: false, richContent: false, priority: false },

  async send({ recipient, title, message, priority, orgId, credentials }) {
    if (!credentials?.account_sid || !credentials?.auth_token) {
      return { success: false, error: 'Twilio account SID and auth token required' };
    }
    if (!credentials?.from_number) {
      return { success: false, error: 'Twilio "from" phone number required' };
    }
    if (!recipient) return { success: false, error: 'Recipient phone number required' };

    const body = title ? `${title}\n${message}` : message;

    try {
      // Twilio uses form-encoded, but we can use the JSON API
      const url = `https://api.twilio.com/2010-04-01/Accounts/${credentials.account_sid}/Messages.json`;
      const params = new URLSearchParams({
        To: recipient,
        From: credentials.from_number,
        Body: body.slice(0, 1600) // SMS limit
      });

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${credentials.account_sid}:${credentials.auth_token}`).toString('base64')
        },
        body: params.toString(),
        signal: AbortSignal.timeout(10000)
      });

      const data = await resp.json().catch(() => ({}));
      if (resp.ok || resp.status === 201) {
        return { success: true, channel: 'sms', message: `SMS sent to ${recipient}` };
      }
      return { success: false, error: data.message || `Twilio returned ${resp.status}` };
    } catch (err) {
      return { success: false, error: `SMS send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.phone || config.phone_number || config.to || null;
  },

  validateRecipient(recipient) {
    return /^\+[1-9]\d{6,14}$/.test(recipient);
  }
};
