/**
 * The perpetual Q: the status glyph that carries state (CLI-QUOX, lab variant "perpetual").
 *
 * ONE fixed shape, a two-cell Braille Q (4 x 4 dots: bowl, counter, tail). It never swaps frames; all of
 * its life is smooth colour (owner, 2026-10-12: "our icons could animate the colour but stay the same icon.
 * Smoother."). Colours are interpolated in OKLab so transitions stay even to the eye:
 *   resting  the Q gradient (sky to violet across the two cells), slow breathing brightness (2.4 s)
 *   working  sky > indigo > violet > teal flowing through the cells (1.6 s a cycle)
 *   waiting  amber, slow pulse (1.2 s)
 *   failing  a red flash (from `since`, 600 ms), then steady red
 * Meant to be sampled at ~12 fps from the shared motion clock. depth '256' steps the colour less often
 * (every 250 ms) and snaps it to the xterm 256 palette, so a 256-colour terminal does not shimmer.
 * Under mono (NO_COLOR) or where Braille does not render two cells wide, it falls back to Ⓠ.
 *
 * PURE AND PORTABLE: no Ink, no process, no timers. Output cells { ch, rgb } plus the joined text and a
 * representative colour, so the terminal (Ink, raw ANSI) and the web face (web/qface.js) draw the same.
 */

export const GLYPH_STATES = ['resting', 'working', 'waiting', 'failing'];
export const FALLBACK = 'Ⓠ';
const SKY = [56, 189, 248], INDIGO = [99, 102, 241], VIOLET = [168, 85, 247], TEAL = [6, 182, 212];
const AMBER = [245, 158, 11], RED = [239, 68, 68];
const TAU = Math.PI * 2;
const wave = (t, period) => 0.5 + 0.5 * Math.sin((t / period) * TAU - Math.PI / 2); // 0 at t=0, 1 at half

// ---- OKLab (Björn Ottosson), for perceptually even blends --------------------------------------------
const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const toSrgb = (c) => Math.round(255 * Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
export function oklab([r, g, b]) {
  const [R, G, B] = [toLin(r), toLin(g), toLin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
/** Blend two sRGB colours in OKLab. */
export const mixOk = (a, b, t) => { const A = oklab(a), B = oklab(b); return fromOklab(A.map((v, i) => v + (B[i] - v) * t)); };
/** Scale lightness in OKLab (k < 1 darker), keeping hue. */
const dimOk = (rgb, k) => { const [L, a, b] = oklab(rgb); return fromOklab([L * k, a * k, b * k]); };
/** A point on a closed OKLab gradient through `stops` at phase p (0..1, wraps). */
export function cycleOk(stops, p) {
  const n = stops.length, x = (((p % 1) + 1) % 1) * n, i = Math.floor(x);
  const t = x - i, e = t * t * (3 - 2 * t); // eased between stops: no visible kinks
  return mixOk(stops[i], stops[(i + 1) % n], e);
}

// ---- the fixed shape ----------------------------------------------------------------------------------
//   .##.
//   #..#
//   #.##
//   .###
export const DOTS = ['.##.', '#..#', '#.##', '.###'];
const BR = [[0x1, 0x8], [0x2, 0x10], [0x4, 0x20], [0x40, 0x80]];
export const SHAPE = [0, 1].map((cx) => {
  let bits = 0;
  for (let y = 0; y < 4; y++) for (let dx = 0; dx < 2; dx++) if (DOTS[y][cx * 2 + dx] === '#') bits |= BR[y][dx];
  return String.fromCharCode(0x2800 + bits);
}).join('');

export const BREATH_MS = 2400, FLOW_MS = 1600, PULSE_MS = 1200, FLASH_MS = 600, STEP_256_MS = 250;
const FLOW = [SKY, INDIGO, VIOLET, TEAL];

/** The two cell colours for a state at t ms. since: when the state began (failing flashes from there). */
export function glyphColors(state, t = 0, { quiet = false, since = null } = {}) {
  switch (state) {
    case 'working': {
      // The gradient flows left to right through the two cells: cell 1 is a quarter cycle behind cell 0.
      const p = quiet ? 0.1 : t / FLOW_MS;
      return [cycleOk(FLOW, p), cycleOk(FLOW, p - 0.25)];
    }
    case 'waiting': {
      const k = quiet ? 1 : 0.45 + 0.55 * wave(t, PULSE_MS);
      return [dimOk(AMBER, k), dimOk(AMBER, k)];
    }
    case 'failing': {
      const dt = since == null || quiet ? Infinity : t - since;
      const f = dt >= 0 && dt < FLASH_MS ? 1 - dt / FLASH_MS : 0; // the flash: red lifted towards white, easing out
      const c = f > 0 ? mixOk(RED, [255, 236, 236], f * f) : RED;
      return [c, c];
    }
    default: {
      const k = quiet ? 0.9 : 0.62 + 0.38 * wave(t, BREATH_MS);
      return [dimOk(SKY, k), dimOk(mixOk(SKY, VIOLET, 0.85), k)];
    }
  }
}

/** Nearest xterm 256-colour cube entry, returned as rgb (so callers keep one colour type). */
export function to256(rgb) {
  const lv = [0, 95, 135, 175, 215, 255];
  const near = (v) => lv.reduce((a, x) => (Math.abs(x - v) < Math.abs(a - v) ? x : a), 0);
  return rgb.map(near);
}

/**
 * Does this terminal draw the Braille glyph? Pure: pass the env and, if you have one, a width measurer
 * (string-width). Braille is skipped under NO_COLOR (mono), TERM=dumb or linux (the VT console font has no
 * Braille), QUOX_GLYPH=circled, or when two Braille cells measure wider than 2.
 */
export function glyphMode(env = {}, measure = null) {
  if (env.NO_COLOR || env.TERM === 'dumb' || env.TERM === 'linux' || env.QUOX_GLYPH === 'circled') return 'circled';
  if (measure && measure('⣿⣿') !== 2) return 'circled';
  return 'braille';
}

/** Colour depth from the env: 'truecolor' | '256' | '16'. Pure. */
export function colorDepth(env = {}) {
  if (/truecolor|24bit/i.test(env.COLORTERM || '')) return 'truecolor';
  if (/256/.test(env.TERM || '')) return '256';
  return env.TERM ? '16' : 'truecolor';
}

/**
 * One frame of the status glyph.
 *   state  resting | working | waiting | failing
 *   t      ms (any monotonic clock); since: ms when the state began (for the failing flash)
 *   opts   { mono, quiet (reduced motion: still colour), mode: 'braille' | 'circled', depth: 'truecolor' | '256' }
 * Returns { text, cells: [{ ch, rgb }], rgb, width }. The text is always the same for a mode: only colour moves.
 */
export function qGlyph(state, t = 0, { mono = false, quiet = false, mode = 'braille', depth = 'truecolor', since = null } = {}) {
  const st = GLYPH_STATES.includes(state) ? state : 'working';
  const tt = depth === '256' ? Math.floor(t / STEP_256_MS) * STEP_256_MS : t;
  let cols = mono ? [null, null] : glyphColors(st, tt, { quiet, since });
  if (depth === '256' && !mono) cols = cols.map(to256);
  if (mono || mode !== 'braille') {
    const rgb = mono ? null : cols[0];
    return { text: FALLBACK, cells: [{ ch: FALLBACK, rgb }], rgb, width: 1 };
  }
  const cells = [...SHAPE].map((ch, i) => ({ ch, rgb: cols[i] }));
  return { text: SHAPE, cells, rgb: cols[0], width: 2 };
}

/** The settled glyph (no motion): what a static surface shows. */
export const glyphStill = (state = 'resting', opts = {}) => qGlyph(state, 0, { ...opts, quiet: true });

/** Truecolor ANSI for a frame (raw terminal use: gallery). */
export function glyphAnsi(g) {
  return g.cells.map((c) => (c.rgb ? `\x1b[38;2;${c.rgb.join(';')}m${c.ch}` : c.ch)).join('') + (g.cells.some((c) => c.rgb) ? '\x1b[0m' : '');
}
