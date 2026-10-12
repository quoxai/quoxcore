/**
 * Email Channel Driver — SMTP notifications via nodemailer.
 */

module.exports = {
  id: 'email',
  name: 'Email',
  category: 'email',
  credentialFields: ['host', 'port', 'user', 'pass', 'from'],
  capabilities: { send: true, receive: false, richContent: true, priority: true, attachments: true },

  async send({ recipient, title, message, priority, orgId, credentials, attachments, html }) {
    const host = credentials?.host;
    if (!host) return { success: false, error: 'SMTP host not configured' };
    if (!recipient) return { success: false, error: 'Email recipient not provided' };

    try {
      const nodemailer = require('nodemailer');
      const port = parseInt(credentials.port || '587');
      const transport = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: credentials.user ? { user: credentials.user, pass: credentials.pass } : undefined
      });

      await transport.sendMail({
        from: credentials.from || 'quox@example.com',
        to: recipient,
        subject: title || 'Quox Notification',
        text: message,
        html: (typeof html === 'string' && html.trim()) ? html : undefined,
        attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined,
        headers: priority === 'urgent' ? { 'X-Priority': '1' } : undefined
      });

      return { success: true, channel: 'email', message: `Email sent to ${recipient}` };
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND') {
        return { success: false, error: 'nodemailer not installed' };
      }
      return { success: false, error: `Email send failed: ${err.message}` };
    }
  },

  resolveRecipient(config) {
    return config.to || config.email || null;
  }
};
