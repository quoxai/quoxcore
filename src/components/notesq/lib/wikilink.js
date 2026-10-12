/** Pure wikilink autocomplete helpers for the NotesQ editor. */

/**
 * If the caret sits inside an unclosed `[[...` on the current line, return
 * { start, query } where start is the index of the first `[` and query is the
 * text typed after `[[`. Otherwise null.
 */
export function detectWikilinkTrigger(text, caret) {
  if (typeof text !== 'string' || !Number.isInteger(caret) || caret < 2) return null;
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('[[');
  if (start === -1) return null;
  const query = before.slice(start + 2);
  if (/[\]\n]/.test(query)) return null;
  if (query.length > 80) return null;
  return { start, query };
}

/**
 * Replace the open `[[query` with `[[Title]]`. Swallows an auto-closed `]]`
 * directly after the caret. Returns { text, caret } (caret after the `]]`).
 */
export function applyWikilink(text, trigger, caret, title) {
  const after = text.slice(caret);
  const rest = after.startsWith(']]') ? after.slice(2) : after;
  const insert = `[[${title}]]`;
  const next = text.slice(0, trigger.start) + insert + rest;
  return { text: next, caret: trigger.start + insert.length };
}
