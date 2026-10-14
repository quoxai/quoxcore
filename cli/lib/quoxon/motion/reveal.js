/**
 * Drop-in reveals (lab prototype `quox-intro-lab fx`): when an item lands in the live region its text decodes
 * in left to right. Just ahead of the resolving edge (LEAD) cells flicker as curated half-width katakana;
 * further ahead they are blank; just behind it a phosphor afterglow tints the real character and fades.
 * Decorative only: every cell is the real character once the reveal ends, widths are identical every frame
 * (a katakana or blank stands only in a one-column cell; wide graphemes are never replaced by a glyph).
 * Pure: (text, elapsed seconds, timing) -> cells.
 */
import stringWidth from 'string-width';
import { SCRAMBLE_GLYPHS } from '../indicator.js';
import { hash3 } from './color.js';
import { graphemes } from '../textBuffer.js';

export const LEAD = 0.14;
/** Timings (seconds). row: tool rows, strongest. dim: grey lines (closing line, notes); short glow, never bold. */
export const TIMING = {
  row: { dur: 0.28, glow: 0.7, bold: true },
  dim: { dur: 0.4, glow: 0.15, bold: false },
  title: { dur: 0.3, glow: 0.35, bold: true },
  roster: { dur: 0.3, glow: 0.3, bold: false },
  settle: { dur: 0.2, glow: 0.5, bold: true },
};
export const revealSpan = (t) => t.dur + t.glow; // seconds from start until every cell is plain
const KEEP = new Set([' ', '│', '─']); // structure only: a '·' separator arrives with its text, never floats ahead of it
const TEXTISH = /^[\p{L}\p{N}\p{P}]+$/u;

/**
 * Cells for `text` at `elapsed` seconds since the reveal started.
 * Each cell: { ch, kind: 'plain'|'kana'|'blank'|'glow', g (glow 0..1), bold }.
 * offset/total let several segments of one row share one sweeping edge.
 */
export function revealCells(text, elapsed, timing = TIMING.row, { offset = 0, total = null, salt = 1 } = {}) {
  const gs = graphemes(String(text ?? '')).map((g) => g.text);
  const n = total ?? gs.length;
  const bucket = Math.floor(elapsed * 30);
  return gs.map((ch, j) => {
    const i = offset + j;
    // Only text decodes: letters, digits, punctuation. Icons and symbols (◐ ✔ ⚠ ⛓ ◉ …) never swap glyphs (owner 2026-10-12).
    if (KEEP.has(ch) || !TEXTISH.test(ch)) return { ch, kind: 'plain', g: 0, bold: false };
    const r = n > 1 ? (i / (n - 1)) * timing.dur : 0;
    const dt = elapsed - r;
    const w = stringWidth(ch);
    if (dt < 0) {
      if (w !== 1) return { ch: ' '.repeat(Math.max(1, w)), kind: 'blank', g: 0, bold: false };
      if (dt < -LEAD) return { ch: ' ', kind: 'blank', g: 0, bold: false };
      return { ch: SCRAMBLE_GLYPHS[Math.floor(hash3(i, bucket, salt) * SCRAMBLE_GLYPHS.length)], kind: 'kana', g: hash3(i, bucket + 7, salt), bold: false };
    }
    const g = timing.glow > 0 && dt < timing.glow ? (1 - dt / timing.glow) ** 1.6 : 0;
    return g > 0 ? { ch, kind: 'glow', g, bold: Boolean(timing.bold) && (dt < 0.05 || g > 0.55) } : { ch, kind: 'plain', g: 0, bold: false };
  });
}

/** True when the reveal has fully ended (all cells plain). */
export const revealDone = (elapsed, timing) => elapsed >= revealSpan(timing);
