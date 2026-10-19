/**
 * /aside in the TUI (pure parts). The answer is a history note with tone 'aside'; its text is
 *   "aside: <question>\n<answer...>\n· <footer>"
 * so the transcript and /share read naturally, and NoteView draws it as a separate block: a violet bar down
 * the left, the question as the header, a read-only footer. Nothing here touches the conversation.
 */
import { asideExcerpt } from '../core/aside.js';

export const ASIDE_FOOTER = 'read only: no tools, not added to this conversation';

/** History + live items -> the last `max` user/assistant exchanges, assistant chunks merged; /commands and !lines skipped. */
export function turnsFromItems(items, max = 10) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it.text !== 'string') continue;
    if (it.kind === 'user' && !it.queued) { if (!/^[/!]/.test(it.text.trim())) out.push({ role: 'user', text: it.text }); } // a /command or !shell line is not conversation
    else if (it.kind === 'text') {
      const last = out[out.length - 1];
      if (last?.role === 'assistant') last.text += it.text; else out.push({ role: 'assistant', text: it.text });
    }
  }
  return out.slice(-max);
}

/** The note text for one aside answer. */
export function asideNoteText(question, answer, meta = {}) {
  const who = meta.model ? ` · ${meta.provider ? `${meta.provider}/` : ''}${meta.model}` : '';
  return `aside: ${String(question).trim()}\n${String(answer || '(no answer)').trim()}\n· ${ASIDE_FOOTER}${who}`;
}

/** -> { head, body: [lines], foot } from a note text (tolerant of a hand-made one). */
export function parseAsideNote(text) {
  const lines = String(text ?? '').split('\n');
  const head = lines[0] || 'aside';
  const footAt = lines.length > 1 && lines[lines.length - 1].startsWith('· ') ? lines.length - 1 : -1;
  const body = lines.slice(1, footAt === -1 ? undefined : footAt);
  return { head, body, foot: footAt === -1 ? null : lines[footAt] };
}

export { asideExcerpt };
