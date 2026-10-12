/**
 * Telegram Channel Driver — Bot API notifications.
 */
const { sendApi } = require('../baseDriver');

module.exports = {
  id: 'telegram',
  name: 'Telegram',
  category: 'messaging',
  credentialFields: ['token'],
  capabilities: { send: true, receive: true, richContent: true, priority: false },

  async send({ recipient, title, message, orgId, credentials, threadKey, parseMode }) {
    const token = credentials?.token;
    if (!token) return { success: false, error: 'Telegram bot token not configured' };
    if (!recipient) return { success: false, error: 'Telegram chat ID not provided' };

    const text = title ? `*${title}*\n${message}` : message;

    const params = { chat_id: recipient, text, parse_mode: parseMode || 'Markdown' };
    // General (the built-in forum topic) must never receive message_thread_id,
    // not even 1: only include it when a real thread key is given.
    if (threadKey !== null && threadKey !== undefined) {
      params.message_thread_id = threadKey;
    }

    try {
      const result = await sendApi(
        'https://api.telegram.org',
        `/bot${token}/sendMessage`,
        params
      );
      if (result.ok) {
        return {
          success: true,
          channel: 'telegram',
          message: `Sent to chat ${recipient}`,
          messageId: result.data?.result?.message_id
        };
      }
      return { success: false, error: `Telegram returned ${result.status}: ${JSON.stringify(result.data)}` };
    } catch (err) {
      return { success: false, error: `Telegram send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.chatId || config.chat_id || null;
  }
};
