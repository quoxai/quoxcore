/**
 * QUOXON-FW6: argument suggestions. After `/command ` the composer suggests the next word, driven
 * by the registry: an entry may declare `args`, a list of levels. A level is
 *   { after: [words...], choices?: [string | { value, desc }], src?: 'name', of?: <word index> }
 * and applies when the words already typed match `after` ('*' matches any word). `src` names an
 * async source the app resolves (slash/argSources.js) with the word at index `of` as its
 * parameter. Levels are checked in order and the first match wins, so put specific levels before
 * wildcard ones. The registry stays plain data and never holds a model list.
 */
import { findEntry } from '../commands.js';

/** The draft as an argument context, or null unless it is `/command <something>` on one line. */
export function argContext(draft) {
  const t = String(draft ?? '');
  if (!t.startsWith('/') || t.startsWith('//') || t.includes('\n')) return null;
  const m = t.match(/^\/(\S+)\s([\s\S]*)$/);
  if (!m) return null;
  const entry = findEntry(m[1]);
  if (!entry || entry.kind !== 'command' || entry.status !== 'active' || !Array.isArray(entry.args))
    return null;
  const rest = m[2];
  const tokens = rest.split(/\s+/);
  const partial = tokens.pop(); // '' when the draft ends in a space
  const words = tokens.filter(Boolean);
  return { entry, words, partial, start: t.length - partial.length };
}

const matches = (after, words) =>
  after.length === words.length &&
  after.every((a, i) => a === '*' || String(words[i]).toLowerCase() === String(a).toLowerCase());

/** The level that suggests the next word after `words`, or null. */
export function levelFor(entry, words) {
  for (const lv of entry.args || []) if (matches(lv.after || [], words)) return lv;
  return null;
}

const asItem = (x) =>
  typeof x === 'string' ? { value: x } : { value: String(x.value), desc: x.desc || '' };

/** Static choices of a level as items. */
export const staticItems = (lv) => (lv?.choices || []).map(asItem);

/** Prefix matches first, then substring; the exact sole match is dropped (nothing to add). */
export function rankArgs(items, partial) {
  const q = String(partial || '').toLowerCase();
  const seen = new Set();
  const uniq = items.map(asItem).filter((i) => i.value && !seen.has(i.value) && seen.add(i.value));
  if (!q) return uniq;
  const pre = uniq.filter((i) => i.value.toLowerCase().startsWith(q));
  const sub = uniq.filter(
    (i) => !i.value.toLowerCase().startsWith(q) && i.value.toLowerCase().includes(q),
  );
  const out = [...pre, ...sub];
  return out.length === 1 && out[0].value.toLowerCase() === q ? [] : out;
}

/**
 * What Tab does: replace the partial word; a trailing space only when another argument can
 * follow.
 */
export function applyArg(draft, ctx, value) {
  const more = levelFor(ctx.entry, [...ctx.words, value]) != null;
  return draft.slice(0, ctx.start) + value + (more ? ' ' : '');
}
