'use strict';

/**
 * ContactsQ structured person names (pure helpers, no DB, no crypto).
 *
 * name = { prefix, given, middle, family, suffix, nickname, phonetic_given, phonetic_family }
 * Organisations never carry parts. display_name for a person is DERIVED from the parts unless an explicit
 * display_name_override is set. A request that sends only display_name (old clients) is split heuristically
 * on create (last token = family, the rest = given; one token = given only), never on update.
 */

const PARTS = ['prefix', 'given', 'middle', 'family', 'suffix', 'nickname', 'phonetic_given', 'phonetic_family'];
const PART_MAX = 100;
const DISPLAY_ORDER = ['prefix', 'given', 'middle', 'family', 'suffix'];
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

const emptyParts = () => Object.fromEntries(PARTS.map((p) => [p, null]));

/**
 * Validate a (possibly partial) name object. -> { ok:true, value:{part: string|null} } (only keys that were sent;
 * '' and null mean "clear") or { ok:false }.
 */
function validateName(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false };
  const value = {};
  for (const [k, v] of Object.entries(input)) {
    if (!PARTS.includes(k)) return { ok: false };
    if (v === null || v === undefined) { value[k] = null; continue; }
    if (typeof v !== 'string') return { ok: false };
    const t = v.trim();
    if (t.length > PART_MAX || CONTROL_RE.test(t)) return { ok: false };
    value[k] = t === '' ? null : t;
  }
  return { ok: true, value };
}

/** Validate display_name_override: null clears, else a trimmed non-empty string <= 200 with no control chars. */
function validateOverride(v) {
  if (v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false };
  const t = v.trim();
  if (!t) return { ok: true, value: null };
  if (t.length > 200 || CONTROL_RE.test(t)) return { ok: false };
  return { ok: true, value: t };
}

const hasAny = (parts) => Boolean(parts) && PARTS.some((p) => parts[p]);

function deriveDisplay(parts) {
  return DISPLAY_ORDER.map((p) => (parts && parts[p]) || '').filter(Boolean).join(' ');
}

/** Heuristic split of a legacy single display name. */
function splitDisplay(display) {
  const toks = String(display || '').trim().split(/\s+/).filter(Boolean);
  const parts = emptyParts();
  if (!toks.length) return parts;
  if (toks.length === 1) { parts.given = toks[0].slice(0, PART_MAX); return parts; }
  parts.family = toks[toks.length - 1].slice(0, PART_MAX);
  parts.given = toks.slice(0, -1).join(' ').slice(0, PART_MAX);
  return parts;
}

function sortNameFor(parts, display) {
  const d = String(display || '');
  if (parts && parts.family) return (parts.given ? `${parts.family}, ${parts.given}` : parts.family).toLowerCase();
  return d.toLowerCase();
}

/** The text whose words feed name search tokens (display, given, middle, family, nickname, phonetic spellings, override). */
function searchText(parts, display, override) {
  const p = parts || {};
  return [display, p.given, p.middle, p.family, p.nickname, p.phonetic_given, p.phonetic_family, override].filter(Boolean).join(' ');
}

/** Merge a partial patch onto existing parts (null clears). */
function mergeParts(existing, patch) {
  const out = { ...emptyParts(), ...(existing || {}) };
  for (const [k, v] of Object.entries(patch || {})) out[k] = v === undefined ? out[k] : v;
  return out;
}

module.exports = { PARTS, PART_MAX, emptyParts, validateName, validateOverride, hasAny, deriveDisplay, splitDisplay, sortNameFor, searchText, mergeParts };
