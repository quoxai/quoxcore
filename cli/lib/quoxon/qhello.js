/**
 * The Q says hello: "Hi, I'm Quox." decoded in beside the mark (CLI-QUOX, lab fx "decode").
 *
 * Characters resolve left to right; just ahead of the edge they flicker as half-width katakana, just behind
 * it a faint phosphor afterglow fades. The final text is always plain and readable. PURE AND PORTABLE: no
 * Ink, no process, no timers; t is ms since the line started. Output cells { ch, rgb, bold } so the CLI and
 * the web face (web/qface.js) draw the same frames.
 */

// Same curated half-width katakana as indicator.js SCRAMBLE_GLYPHS: one cell each, none reads as Latin.
export const KANA = 'ｱｳｶｷｸｹｺｻﾀﾁﾂﾇﾊﾋﾎﾏﾐﾑﾒﾗ';
export const LEAD_MS = 140, GLOW_MS = 700;
const SKY = [56, 189, 248];
const DIM = [58, 66, 82], TXT = [226, 232, 240], GLOWC = [110, 231, 183];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const clamp = (x) => Math.max(0, Math.min(1, x));
const hash = (a, b, c) => { let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

/** How long a line of n characters takes to settle (decode plus afterglow). */
export const helloMs = (text, perChar = 28) => Math.max(1, [...String(text)].length - 1) * perChar + GLOW_MS;

/**
 * Decode frame of `text` at t ms. fg: rgb for the settled text (default near-white), or a function
 * (i, ch) -> rgb (a gradient). mono: no colour (glyph flicker stays: motion is not colour).
 * Returns [{ ch, rgb, bold }], always text.length cells; blanks are ' ' (never shifting the line).
 */
export function helloCells(text, t, { perChar = 28, fg = TXT, mono = false, salt = 7 } = {}) {
  const chars = [...String(text)];
  const fgAt = typeof fg === 'function' ? fg : () => fg;
  return chars.map((ch, i) => {
    if (ch === ' ') return { ch, rgb: null, bold: false };
    const dt = t - i * perChar;
    if (dt < -LEAD_MS) return { ch: ' ', rgb: null, bold: false };
    if (dt < 0) {
      const b = Math.floor(t / 33);
      const k = KANA[Math.floor(hash(i, b, salt) * KANA.length)];
      return { ch: k, rgb: mono ? null : mix(DIM, SKY, 0.35 + 0.65 * hash(i, b + 7, salt)), bold: false };
    }
    const g = dt < GLOW_MS ? (1 - dt / GLOW_MS) ** 1.6 : 0;
    return { ch, rgb: mono ? null : mix(fgAt(i, ch), GLOWC, 0.5 * g), bold: !mono && (dt < 50 || g > 0.55) };
  });
}

/** Is the line fully settled (plain text, no glow) at t? */
export const helloSettled = (text, t, perChar = 28) => t >= helloMs(text, perChar);

/** The settled text's gradient (sky to violet across the line), for callers that want the brand look. */
export const helloGradient = (text) => {
  const n = Math.max(1, [...String(text)].length - 1);
  return (i) => mix([56, 189, 248], [168, 85, 247], clamp(i / n));
};

/** Cells -> truecolor ANSI string (bold where marked). */
export function helloAnsi(cells) {
  let s = '';
  for (const c of cells) s += (c.bold ? '\x1b[1m' : '') + (c.rgb ? `\x1b[38;2;${c.rgb.join(';')}m` : '') + c.ch + (c.rgb || c.bold ? '\x1b[0m' : '');
  return s;
}
