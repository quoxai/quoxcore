/**
 * Email Tool Executor (IMAP)
 *
 * Native executor for the `email_read` agent tool. Owns the IMAP session
 * lifecycle only (connect → fetch → parse → logout) — credential resolution,
 * input validation, and response shaping live in agentTools.js.
 *
 * SECURITY: this module is handed a plaintext password by the caller for the
 * sole purpose of opening the IMAP connection. It must never log it or
 * include it in a thrown error.
 *
 * Testing seam: the ImapFlow class and simpleParser fn are passed in by the
 * caller (agentTools.js) rather than required at module scope here. vitest's
 * module runner does not intercept nested CJS require() calls for bare npm
 * specifiers reliably in this repo's CJS/ESM hybrid setup — and a
 * module-local __setXForTesting() seam on *this* file doesn't help either,
 * because agentTools.js reaches this module via require() while a vitest
 * spec reaches it via import(), which can resolve to a different module
 * cache entry (confirmed empirically). Passing the implementations through
 * as call arguments avoids the shared-module-instance assumption entirely —
 * agentTools.js exposes __setImapFlowForTesting / __setSimpleParserForTesting
 * on itself (same instance the test's `TOOL_DEFS` import uses).
 */

const RealImapFlow = require('imapflow').ImapFlow;
const realSimpleParser = require('mailparser').simpleParser;

/**
 * Connect to a mailbox over IMAP and return the most recent (or unseen)
 * messages, parsed to plain text snippets.
 *
 * @param {object} opts
 * @param {string} opts.host - IMAP host
 * @param {number|string} [opts.port] - IMAP port (default 993)
 * @param {string} opts.user - IMAP username
 * @param {string} opts.pass - IMAP password (never logged/returned)
 * @param {string} [opts.folder] - mailbox/folder to open (default INBOX)
 * @param {number} [opts.limit] - max messages to return (default 10)
 * @param {boolean} [opts.unseenOnly] - only return unread messages
 * @param {Function} [opts.ImapFlow] - ImapFlow class override (testing)
 * @param {Function} [opts.simpleParser] - simpleParser fn override (testing)
 * @returns {Promise<{folder: string, count: number, messages: object[]}>}
 */
async function readMailbox({
  host, port, user, pass, folder = 'INBOX', limit = 10, unseenOnly = false,
  ImapFlow = RealImapFlow, simpleParser = realSimpleParser,
}) {
  const client = new ImapFlow({
    host,
    port: Number(port) || 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    socketTimeout: 15000,
  });

  let lock = null;
  try {
    await client.connect();
    lock = await client.getMailboxLock(folder);

    const fetchOptions = { envelope: true, source: true, uid: true };
    let iterable = [];

    if (unseenOnly) {
      // Search for unseen UIDs, then fetch the most recent `limit` of them.
      const uids = await client.search({ seen: false }, { uid: true });
      const targetUids = (uids || []).slice(-limit);
      if (targetUids.length > 0) {
        iterable = client.fetch(targetUids.join(','), fetchOptions, { uid: true });
      }
    } else {
      // No search needed — after getMailboxLock() imapflow exposes the
      // selected mailbox's message count on client.mailbox.exists. Fetch the
      // last `limit` messages by sequence range (start:*).
      const total = client.mailbox?.exists || 0;
      if (total > 0) {
        const start = Math.max(1, total - limit + 1);
        iterable = client.fetch(`${start}:*`, fetchOptions);
      }
    }

    const messages = [];
    for await (const msg of iterable) {
      let snippet = '';
      try {
        const parsed = await simpleParser(msg.source);
        const raw = parsed?.text || (parsed?.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : '') || '';
        snippet = raw.trim().slice(0, 2000);
      } catch {
        // Parse failure — leave snippet empty rather than failing the whole read.
      }

      const fromEnvelope = msg.envelope?.from?.[0];
      const from = fromEnvelope
        ? (fromEnvelope.name ? `${fromEnvelope.name} <${fromEnvelope.address}>` : fromEnvelope.address)
        : '';

      messages.push({
        uid: msg.uid,
        from,
        subject: msg.envelope?.subject || '',
        date: msg.envelope?.date || null,
        snippet,
      });

      if (messages.length >= limit) break;
    }

    return { folder, count: messages.length, messages };
  } finally {
    try { if (lock) lock.release(); } catch { /* non-fatal */ }
    try { await client.logout(); } catch { /* non-fatal — connection may never have opened */ }
  }
}

module.exports = {
  readMailbox,
};
