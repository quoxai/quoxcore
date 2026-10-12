/**
 * A chat answer as a NotesQ note (AQ-9D P4 "+Note on chat messages"). The
 * title is the question that produced the answer, so the note is findable.
 */
export function chatToNote({ answer, question, agentName, at = new Date() }) {
  const q = String(question || '').replace(/\s+/g, ' ').trim();
  const title = (q ? (q.length > 80 ? `${q.slice(0, 80).trimEnd()}...` : q) : `Chat answer ${at.toISOString().slice(0, 10)}`).replace(/^#+\s*/, '');
  const quotedQ = q ? `> ${q}\n\n` : '';
  const footer = `\n\n---\n*Saved from chat${agentName ? ` with ${agentName}` : ''} on ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC*\n`;
  const markdown = `# ${title}\n\n${quotedQ}${String(answer || '').trim()}${footer}`;
  return { title, markdown, properties: { source: 'chat', ...(agentName ? { chat_agent: agentName } : {}) } };
}
