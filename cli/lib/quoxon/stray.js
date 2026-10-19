/**
 * TUI-INPUT: a letter then "/" ("n/help") is a card answer that leaked into the composer ahead of a command.
 * Pure: -> { letter, command } when the text looks like that and the rest names a known slash command, else null.
 * (Ordinary "w/o", "b/c" or "and/or" never match: the word after the slash must be a command.)
 */
export function strayCardAnswer(text, names = []) {
  const t = String(text ?? '').trim();
  const m = /^([a-z])\/([a-z][\w-]*)(?=\s|$)/i.exec(t);
  if (!m) return null;
  if (!names.includes(`/${m[2].toLowerCase()}`)) return null;
  return { letter: m[1].toLowerCase(), command: t.slice(1) };
}

/** The one-line question (askText adds the y/N/c keys). */
export const strayQuestion = (s) => `Did you mean ${s.command.split(/\s+/)[0]}? (the '${s.letter}' looks like a stray card answer)`;

/** True when the same message is already queued, steered or waiting for the server. */
export function alreadyQueued(text, { pending = [], steering = [], waiting = null } = {}) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return [...pending, ...steering].some(p => String(p.text ?? '').trim() === t) || String(waiting?.text ?? '').trim() === t;
}
