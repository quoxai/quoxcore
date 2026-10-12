/**
 * An InboxQ message as a NotesQ note. Mirrored, not imported, in
 * cli/lib/commands/notesBridges.js (emailToNote): the CLI ships without src,
 * and both surfaces must write the same note shape. Change both together.
 */
export function emailToNote(msg) {
  const subject = String(msg.subject || '').replace(/[\r\n]+/g, ' ').trim() || '(no subject)';
  const from = msg.fromName && msg.fromAddr ? `${msg.fromName} <${msg.fromAddr}>` : (msg.fromAddr || msg.fromName || 'unknown sender');
  const date = msg.dateTs ? new Date(Number(msg.dateTs) < 1e12 ? Number(msg.dateTs) * 1000 : Number(msg.dateTs)).toISOString() : null;
  let body = typeof msg.bodyText === 'string' && msg.bodyText.trim() ? msg.bodyText : null;
  let bodySource = 'text';
  if (!body && typeof msg.bodyHtml === 'string' && msg.bodyHtml.trim()) {
    body = msg.bodyHtml
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n');
    bodySource = 'html';
  }
  if (!body) { body = msg.snippet || ''; bodySource = 'snippet'; }
  const quoted = String(body).trim().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
  const markdown = `# ${subject}\n\n**From:** ${from}  \n${date ? `**Date:** ${date}  \n` : ''}**Saved from InboxQ**\n\n${quoted}\n`;
  const properties = { source: 'inboxq', inboxq_message_id: msg.id, email_from: msg.fromAddr || from, ...(date ? { email_date: date } : {}) };
  return { title: subject, markdown, properties, bodySource };
}
