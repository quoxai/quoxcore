/**
 * NotesQ AssistantQ wires (AQ-9D P4), pure helpers. Each wire composes at the
 * edge: the CLI reads through the other plugin's own governed route (its
 * licence, access rules and audit) and writes through NotesQ's, so no new
 * server path reads another plugin's data.
 */

import { createHash } from 'crypto';

const short = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/** An InboxQ message as a note. Body text preferred; HTML is reduced to text; snippet is the last resort. */
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

/**
 * Unchecked markdown tasks (`- [ ] text`, `* [ ]`, `1. [ ]`) outside code
 * fences, each with a stable short hash so a re-run can skip ones already sent.
 */
export function extractTasks(markdown) {
  const out = [];
  let fence = false;
  for (const line of String(markdown || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.+?)\s*$/.exec(line);
    if (m && m[1]) out.push({ text: m[1].slice(0, 200), hash: short(m[1].trim().toLowerCase()) });
  }
  return out;
}

/** The QuoxPlan stream note for a promoted NotesQ note: title, link, and an excerpt. */
export function promoteBody(note, link) {
  const body = String(note.markdown || '').replace(/^\s*#\s+.+\n+/, '').trim();
  const excerpt = body.length > 1500 ? `${body.slice(0, 1500).trimEnd()}...` : body;
  return `NotesQ: "${note.title || 'Untitled'}" ${link}${excerpt ? `\n\n${excerpt}` : ''}`;
}
