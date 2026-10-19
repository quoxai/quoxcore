/**
 * One preview card, one y/n. Shared by /watch, /automate and /crystallize: a direct human ask is already the
 * authorization, so the preview is the only confirmation. The answer is the next composer line (same pattern as the
 * /approve "y/N" grant); a slash command typed instead drops the preview and runs normally.
 */
import { askText } from '../ask.js';
export function createConfirm({ say, ttlMs = 120000, now = () => Date.now() }) {
  let p = null;
  return {
    pending: () => Boolean(p),
    /** y/N/c: a chat about the ask keeps it open with a fresh window. */
    touch() { if (p) p.at = now(); },
    ask(lines, onYes, { prompt = 'Go ahead?' } = {}) {
      p = { onYes, at: now() };
      for (const l of lines) (Array.isArray(l) ? say(l[0], l[1]) : say(l));
      say(askText(String(prompt).replace(/\s*y\/n$/i, '')), 'ask'); // QUOXON-ASK: one shape
    },
    /** -> true when this line was the answer (consumed); false when the caller should treat it as an ordinary line. */
    answer(text) {
      if (!p) return false;
      const q = p; p = null;
      const t = String(text || '').trim();
      if (t.startsWith('/')) return false;
      if (now() - q.at > ttlMs) { say('That preview expired, so nothing was created. Run the command again.', 'dim'); return true; }
      if (/^y(es)?$/i.test(t)) { Promise.resolve(q.onYes()).catch((e) => say(`Failed: ${e?.message || e}`, 'warn')); return true; }
      say('Cancelled; nothing was created.', 'dim');
      return true;
    }
  };
}
