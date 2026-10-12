/**
 * Structured person names (server contract: `name` = {prefix, given, middle, family, suffix,
 * nickname, phonetic_given, phonetic_family}; organisations have name: null). Older collectors
 * send no `name` key at all, so every helper falls back to display_name and nothing breaks.
 */
export const NAME_PARTS = ['prefix', 'given', 'middle', 'family', 'suffix', 'nickname'];
export const PHONETIC_PARTS = ['phonetic_given', 'phonetic_family'];
const ALL_PARTS = [...NAME_PARTS, ...PHONETIC_PARTS];
const DISPLAY_ORDER = ['prefix', 'given', 'middle', 'family', 'suffix'];

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/** "Dr Ada M Lovelace Jr" from the parts (nickname and phonetics are not part of the display name). */
export function joinName(name) {
  if (!name || typeof name !== 'object') return '';
  return DISPLAY_ORDER.map((k) => clean(name[k])).filter(Boolean).join(' ');
}

/**
 * The name to show for a card. Parts win when present; an explicit override (or a display_name
 * that evidently differs from the parts, which is how an override reaches us) wins over both.
 */
export function cardName(card) {
  if (!card) return '';
  if (clean(card.display_name_override)) return clean(card.display_name_override);
  const joined = joinName(card.name);
  const shown = clean(card.display_name);
  if (!joined) return shown;
  return shown && shown !== joined ? shown : joined;
}

/** Two-letter avatar initials: given+family when known, otherwise the first letters of the first two words. */
export function initialsOf(card) {
  const g = clean(card?.name?.given);
  const f = clean(card?.name?.family);
  const letters = g && f ? [g, f] : cardName(card).split(/\s+/).filter(Boolean);
  // First LETTER (or digit) of each word, so '(demo)' gives D, never '('.
  const firstLetter = (w) => Array.from(w).find((ch) => /[\p{L}\p{N}]/u.test(ch)) || '';
  const out = letters.map(firstLetter).filter(Boolean).slice(0, 2).join('');
  return (out || '?').toUpperCase();
}

/** True when the card should be edited with name parts (a person from a collector that sends `name`). */
export const hasStructuredName = (card) => !!card && card.kind !== 'organisation' && card.name !== undefined;

/** Form state for the name fields, from a card (or blank). */
export function nameFormFrom(card) {
  const f = {};
  ALL_PARTS.forEach((k) => { f[k] = clean(card?.name?.[k]); });
  const joined = joinName(card?.name);
  const shown = clean(card?.display_name);
  f.override = clean(card?.display_name_override) || (joined && shown && shown !== joined ? shown : '');
  return f;
}

/** Only the non-empty parts, for creating a contact. */
export function nameBodyFrom(f) {
  const name = {};
  ALL_PARTS.forEach((k) => { if (clean(f[k])) name[k] = clean(f[k]); });
  return name;
}

/** Changed parts only, for a PUT (an emptied part is sent as '' so the server can clear it). */
export function namePatchFrom(card, f) {
  const before = nameFormFrom(card);
  const name = {};
  ALL_PARTS.forEach((k) => { if (clean(f[k]) !== before[k]) name[k] = clean(f[k]); });
  const patch = {};
  if (Object.keys(name).length) patch.name = name;
  if (clean(f.override) !== before.override) patch.display_name_override = clean(f.override) || null;
  return patch;
}

const PREFIXES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'professor', 'sir', 'dame', 'rev', 'hon', 'lord', 'lady', 'capt', 'col', 'major', 'sgt', 'fr']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'phd', 'md', 'mba', 'esq', 'cpa', 'dds', 'obe', 'mbe', 'cbe', 'bsc', 'msc', 'ma', 'ba']);
const PARTICLES = new Set(['van', 'von', 'de', 'del', 'della', 'di', 'da', 'dos', 'du', 'le', 'la', 'bin', 'ibn', 'al', 'el', 'st', 'ter', 'ten']);
const bare = (t) => t.replace(/[.,]+$/g, '').toLowerCase();

/**
 * Best-effort split of one name field into parts, for the "Split name" helper. It only PROPOSES: the person
 * confirms (and can correct) before anything is saved. Handles titles (Dr, Prof), suffixes (Jr, PhD),
 * "Family, Given" order and surname particles (van, von, de). Returns only the non-empty parts.
 */
export function splitFullName(display) {
  let text = clean(display).replace(/\s+/g, ' ');
  if (!text) return {};
  let commaFamily = null;
  const comma = text.indexOf(',');
  if (comma > 0) {
    const tail = text.slice(comma + 1).trim();
    const tailTokens = tail.split(' ').filter(Boolean);
    // "Smith, Jr." is a suffix; "Lovelace, Ada Augusta" is Family, Given Middle.
    if (!(tailTokens.length && tailTokens.every((t) => SUFFIXES.has(bare(t))))) {
      commaFamily = text.slice(0, comma).trim();
      text = tail;
    } else {
      text = `${text.slice(0, comma)} ${tail}`;
    }
  }
  const toks = text.split(' ').filter(Boolean);
  const out = { prefix: [], suffix: [] };
  while (toks.length > 1 && PREFIXES.has(bare(toks[0]))) out.prefix.push(toks.shift().replace(/,+$/, ''));
  while (toks.length > 1 && SUFFIXES.has(bare(toks[toks.length - 1]))) out.suffix.unshift(toks.pop().replace(/,+$/, ''));
  let given = '';
  let middle = '';
  let family = '';
  if (commaFamily !== null) {
    family = commaFamily;
    given = toks[0] || '';
    middle = toks.slice(1).join(' ');
  } else if (toks.length === 1) {
    given = toks[0];
  } else if (toks.length > 1) {
    const famToks = [toks.pop()];
    while (toks.length > 1 && PARTICLES.has(bare(toks[toks.length - 1]))) famToks.unshift(toks.pop());
    family = famToks.join(' ');
    given = toks.shift();
    middle = toks.join(' ');
  }
  const parts = { prefix: out.prefix.join(' '), given, middle, family, suffix: out.suffix.join(' ') };
  return Object.fromEntries(Object.entries(parts).filter(([, v]) => v));
}

/** True when a person's card carries at least one name part (so the name is no longer one field). */
export const hasNameParts = (card) => !!card && NAME_PARTS.some((k) => clean(card.name?.[k]));

const PART_LABELS = {
  prefix: 'Title', given: 'Given name', middle: 'Middle name', family: 'Family name', suffix: 'Suffix', nickname: 'Nickname',
  phonetic_given: 'Given name, as said', phonetic_family: 'Family name, as said',
};
/** [{key,label,value}] for every name part that is set, in reading order, for the Overview. */
export function namePartRows(card) {
  if (!card || card.kind === 'organisation' || !card.name) return [];
  return [...NAME_PARTS, ...PHONETIC_PARTS].filter((k) => clean(card.name[k])).map((k) => ({ key: k, label: PART_LABELS[k], value: clean(card.name[k]) }));
}
