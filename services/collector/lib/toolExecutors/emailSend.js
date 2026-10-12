/**
 * Email Send Tool Executor (SMTP)
 *
 * Native executor for the `email_send` agent tool. Owns the SMTP transport
 * lifecycle only (build transport → sendMail) — credential resolution,
 * input validation, and response shaping live in agentTools.js.
 *
 * SECURITY: this module is handed a plaintext password by the caller for the
 * sole purpose of authenticating the SMTP transport. It must never log it or
 * include it in a thrown error.
 *
 * Testing seam: the nodemailer module is passed in by the caller
 * (agentTools.js) rather than required at module scope here. vitest's
 * module runner does not intercept nested CJS require() calls for bare npm
 * specifiers reliably in this repo's CJS/ESM hybrid setup — and a
 * module-local __setXForTesting() seam on *this* file doesn't help either,
 * because agentTools.js reaches this module via require() while a vitest
 * spec reaches it via import(), which can resolve to a different module
 * cache entry (confirmed empirically for email_read/toolExecutors/email.js).
 * Passing the implementation through as a call argument avoids the
 * shared-module-instance assumption entirely — agentTools.js exposes
 * __setNodemailerForTesting on itself (same instance the test's `TOOL_DEFS`
 * import uses).
 */

const realNodemailer = require('nodemailer');

/**
 * Send an email over SMTP using resolved vault credentials.
 *
 * @param {object} opts
 * @param {string} opts.host - SMTP host
 * @param {number|string} [opts.port] - SMTP port (default 587)
 * @param {boolean} [opts.secure] - use implicit TLS (default false)
 * @param {string} opts.user - SMTP username
 * @param {string} opts.pass - SMTP password (never logged/returned)
 * @param {string} opts.from - envelope/from address
 * @param {string|string[]} opts.to - recipient(s)
 * @param {string|string[]} [opts.cc] - cc recipient(s)
 * @param {string|string[]} [opts.bcc] - bcc recipient(s)
 * @param {string} opts.subject - message subject
 * @param {string} [opts.text] - plain text body
 * @param {string} [opts.html] - html body
 * @param {object} [opts.nodemailer] - nodemailer module override (testing)
 * @returns {Promise<{messageId: string, accepted: any[], rejected: any[]}>}
 */
async function sendMail({
  host, port, secure, user, pass, from, to, cc, bcc, subject, text, html,
  nodemailer = realNodemailer,
}) {
  const transport = nodemailer.createTransport({
    host,
    port: Number(port) || 587,
    secure: !!secure,
    auth: { user, pass },
  });

  const info = await transport.sendMail({ from, to, cc, bcc, subject, text, html });

  return {
    messageId: info?.messageId,
    accepted: info?.accepted || [],
    rejected: info?.rejected || [],
  };
}

module.exports = {
  sendMail,
};
