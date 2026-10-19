/**
 * TUI-FOOTER: terminal cell widths for the bottom chrome (divider, custom rows, status rows).
 *
 * string-width counts East Asian Ambiguous characters as one cell. Several of ours are Ambiguous: the ' · '
 * separator, ● Ⓠ │ ─ ▁ █ ▲ ▼ ▶. A terminal set to draw them wide (a CJK locale, or the "ambiguous characters
 * are wide" option in iTerm2, VTE or Windows Terminal) gives each two cells, so a row measured to fit overflows
 * and the terminal wraps it mid-label. Policy, in order: QUOX_AMBIGUOUS=wide|narrow; else a ja/zh/ko locale
 * (LC_ALL, LC_CTYPE, LANG) means wide; else narrow (what nearly every Western terminal does).
 * Pure apart from the env default; no extra dependency (the ranges below are Unicode EastAsianWidth=A, U+00A0..U+2FFF,
 * combining marks excluded since they take no cell).
 */
import stringWidth from 'string-width';

const RANGES = ('a1 a4 a7-a8 aa ad-ae b0-b4 b6-ba bc-bf c6 d0 d7-d8 de-e1 e6 e8-ea ec-ed f0 f2-f3 f7-fa fc fe 101 111 113 11b ' +
  '126-127 12b 131-133 138 13f-142 144 148-14b 14d 152-153 166-167 16b 1ce 1d0 1d2 1d4 1d6 1d8 1da 1dc 251 261 2c4 2c7 2c9-2cb ' +
  '2cd 2d0 2d8-2db 2dd 2df 391-3a1 3a3-3a9 3b1-3c1 3c3-3c9 401 410-44f 451 2010 2013-2016 2018-2019 201c-201d 2020-2022 ' +
  '2024-2027 2030 2032-2033 2035 203b 203e 2074 207f 2081-2084 20ac 2103 2105 2109 2113 2116 2121-2122 2126 212b 2153-2154 ' +
  '215b-215e 2160-216b 2170-2179 2189 2190-2199 21b8-21b9 21d2 21d4 21e7 2200 2202-2203 2207-2208 220b 220f 2211 2215 221a ' +
  '221d-2220 2223 2225 2227-222c 222e 2234-2237 223c-223d 2248 224c 2252 2260-2261 2264-2267 226a-226b 226e-226f 2282-2283 ' +
  '2286-2287 2295 2299 22a5 22bf 2312 2460-24e9 24eb-254b 2550-2573 2580-258f 2592-2595 25a0-25a1 25a3-25a9 25b2-25b3 ' +
  '25b6-25b7 25bc-25bd 25c0-25c1 25c6-25c8 25cb 25ce-25d1 25e2-25e5 25ef 2605-2606 2609 260e-260f 261c 261e 2640 2642 ' +
  '2660-2661 2663-2665 2667-266a 266c-266d 266f 269e-269f 26bf 26c6-26cd 26cf-26d3 26d5-26e1 26e3 26e8-26e9 26eb-26f1 26f4 ' +
  '26f6-26f9 26fb-26fc 26fe-26ff 273d 2776-277f 2b56-2b59')
  .split(' ').map((r) => { const [a, b = a] = r.split('-'); return [parseInt(a, 16), parseInt(b, 16)]; });

/** Is this code point East Asian Ambiguous (drawn one or two cells depending on the terminal)? */
export function isAmbiguous(cp) {
  let lo = 0, hi = RANGES.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (cp < RANGES[m][0]) hi = m - 1; else if (cp > RANGES[m][1]) lo = m + 1; else return true;
  }
  return false;
}

/** The ambiguous-width policy for this terminal: true when Ambiguous characters take two cells. */
export function ambiguousWide(env = process.env) {
  const o = String(env.QUOX_AMBIGUOUS || '').toLowerCase();
  if (o === 'wide') return true;
  if (o === 'narrow') return false;
  return /^(ja|zh|ko)([_.@-]|$)/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '');
}

const ANSI = /\x1b\[[0-9;]*m/g;
/** Cells `text` takes in a terminal with the given ambiguous-width policy (escapes take none). */
export function cellWidth(text, { wide = ambiguousWide() } = {}) {
  const t = String(text ?? '');
  let w = stringWidth(t);
  if (!wide) return w;
  for (const ch of t.replace(ANSI, '')) if (isAmbiguous(ch.codePointAt(0))) w += 1;
  return w;
}

