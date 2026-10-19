/**
 * One card, one y/n. The answer is the next composer line (the /approve "y/N" pattern); a slash command typed
 * instead drops the card. A direct human ask is already the authorization, so the card is the only gate.
 * (Own copy for /undo and /wish; kept in this file so it does not depend on another branch's helper.)
 */
import { askText } from '../ask.js';
export function createCard({ say, now = () => Date.now(), ttlMs = 120000 }) {
  let pending = null;
  return {
    pending: () => Boolean(pending),
    /** y/N/c: a chat about the ask keeps it open with a fresh window. */
    touch() { if (pending) pending.at = now(); },
    ask(lines, onYes, cancelText, { question = 'Go ahead?', reason = '', who = '', action = '' } = {}) {
      pending = { onYes, at: now(), cancelText };
      for (const l of lines) say(l);
      say(askText(question, { reason, who, action }), 'ask'); // QUOXON-ASK: one shape (live 22:41: /wish ended in a bare "y/n")
    },
    /** -> true when this line was the answer (consumed). */
    answer(text) {
      if (!pending) return false;
      const q = pending; pending = null;
      const t = String(text || '').trim();
      if (t.startsWith('/')) return false;
      if (now() - q.at > ttlMs) { say('That card expired, so nothing was done. Run the command again.', 'dim'); return true; }
      if (/^y(es)?$/i.test(t)) { Promise.resolve(q.onYes()).catch((e) => say(`Failed: ${e?.message || e}`, 'warn')); return true; }
      say(q.cancelText, 'dim');
      return true;
    }
  };
}
