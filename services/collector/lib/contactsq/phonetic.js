'use strict';

/**
 * ContactsQ phonetic keys (no dependency). Deterministic English-leaning code:
 * light spelling normalisation (ph->f, kn->n, wr->r, sch->sk, ...) then
 * American Soundex (h/w transparent). Sean/Shawn/Shaun share S500, Jon/John
 * share J500. Coarse by design: it only widens candidate recall; the search
 * ranker scores a phonetic hit below an exact or token hit and flags ambiguity.
 */

const CODES = { b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 };

function stripAccents(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, ''); }

function words(text) {
  return stripAccents(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function phoneticKey(word) {
  let w = stripAccents(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  w = w.replace(/^kn/, 'n').replace(/^wr/, 'r').replace(/^ps/, 's').replace(/^wh/, 'w')
    .replace(/^x/, 'z').replace(/sch/g, 'sk').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/dg/g, 'j');
  const first = w[0];
  let out = first.toUpperCase();
  let prev = CODES[first] || 0;
  for (let i = 1; i < w.length && out.length < 4; i++) {
    const ch = w[i];
    if (ch === 'h' || ch === 'w') continue; // transparent: does not reset prev
    const code = CODES[ch] || 0;
    if (code && code !== prev) out += code;
    prev = code;
  }
  return out.padEnd(4, '0');
}

module.exports = { phoneticKey, words };
