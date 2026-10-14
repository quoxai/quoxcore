/**
 * Inline object views (QUOXON plan E2/E3, lab group E and D): shared, pure helpers.
 *
 * A view is { box?, rows } where a row is an array of segments { text, role, bold? }. Roles are theme
 * roles ('value', 'muted', 'ok', 'warn', 'error', 'key', 'sky', 'teal', 'indigo', 'violet', 'faint') or
 * 'agent:<name>', 'provider:<id>', 'proto:<aee|aocl|volt|ward>'. Nothing here does I/O or reads a clock:
 * time arrives as `now`. Rule for every builder: a field the server did not supply is omitted, never
 * invented, and an unreachable source is said plainly.
 */
import { KANA } from '../qhello.js';

export const seg = (text, role = 'value', bold = false) => ({ text: String(text ?? ''), role, bold });
export const len = (s) => [...String(s ?? '')].length;
export const rowText = (row) => row.map(s => s.text).join('');
export const rowLen = (row) => len(rowText(row));

/** Clip a string to n display chars with an ellipsis (the lab's fit()). */
export const fit = (s, n) => {
  const g = [...String(s ?? '').replace(/\s+/g, ' ').trim()];
  if (n <= 0) return '';
  return g.length > n ? g.slice(0, Math.max(0, n - 1)).join('') + '…' : g.join('');
};

/** Clip a row of segments to n chars total; later segments shrink first, the last one gets the ellipsis. */
export function fitRow(row, n) {
  const out = [];
  let used = 0;
  for (const s of row) {
    const room = n - used;
    if (room <= 0) break;
    const l = len(s.text);
    if (l <= room) { out.push(s); used += l; continue; }
    out.push({ ...s, text: fit(s.text, room) });
    used = n;
    break;
  }
  return out;
}

/** Pad a row to exactly n chars (clip first). */
export function padRow(row, n) {
  const r = fitRow(row, n);
  const l = rowLen(r);
  return l < n ? [...r, seg(' '.repeat(n - l), 'muted')] : r;
}

/** Server timestamps: epoch ms, ISO, or SQLite "YYYY-MM-DD HH:MM:SS" (UTC). */
export function parseTs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v);
  const t = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return Number.isFinite(t) ? t : null;
}

/** "45s", "3m", "2h", "28d" between two epoch ms. '' when unknown. */
export function ago(ts, now) {
  const t = parseTs(ts);
  if (t == null || !Number.isFinite(now)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Duration in ms -> "0.4s", "3.4s", "2m05". */
export function dur(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 60000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`;
}

/** "21:20 UTC" from a timestamp (UTC on purpose: the box and the owner are in different zones). */
export function hhmm(ts) {
  const t = parseTs(ts);
  return t == null ? '' : `${new Date(t).toISOString().slice(11, 16)} UTC`;
}
export const day = (ts) => { const t = parseTs(ts); return t == null ? '' : new Date(t).toISOString().slice(0, 10); };
export const short = (id, n = 8) => { const s = String(id ?? ''); return s.length > n + 1 ? s.slice(0, n) + '…' : s; };
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Box geometry the lab uses: the box is at most `max` wide and never wider than the terminal less 2. */
export const boxWidth = (cols, max) => Math.max(20, Math.min((cols || 80) - 2, max));

// ---- decode-in (the lab's text arrival) --------------------------------------------------------------
// Katakana flicker just ahead of the reveal edge; resolved letters keep their role. Pure: t and t0 in
// seconds, salt keeps rows distinct. The colour-only afterglow is left to the renderer (it maps `glow`).
const LEAD = 0.07, GLOW = 0.6, PER_CHAR = 0.012;
const hash = (a, b, c) => { let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

/**
 * -> cells [{ ch, role, bold, glyph, glow }] for one row at time t (seconds since the object arrived).
 * t = Infinity (or quiet) gives the settled row. A row starts at t0 and resolves left to right over dur.
 */
export function decodeRow(row, t, t0 = 0, d = 0.25, salt = 1) {
  const chars = [];
  for (const s of row) for (const ch of s.text) chars.push({ ch, role: s.role, bold: Boolean(s.bold) });
  if (!Number.isFinite(t)) return chars.map(c => ({ ...c, glyph: false, glow: 0 }));
  const n = chars.length;
  const span = Math.max(d, n * PER_CHAR);
  return chars.map((c, i) => {
    if (c.ch === ' ') return { ...c, glyph: false, glow: 0 };
    const r = t0 + (n > 1 ? (i / (n - 1)) * span : 0), dt = t - r;
    if (dt < -LEAD) return { ch: ' ', role: c.role, bold: false, glyph: false, glow: 0 };
    if (dt < 0) return { ch: KANA[Math.floor(hash(i, Math.floor(t * 30), salt) * KANA.length)], role: 'sky', bold: false, glyph: true, glow: 0 };
    return { ...c, bold: c.bold || dt < 0.05, glyph: false, glow: dt < GLOW ? (1 - dt / GLOW) ** 1.6 : 0 };
  });
}

/** Seconds the arrival of a view takes: rows start 0.1 s apart and each resolves over 0.25 s. */
export function arrivalSeconds(view) {
  const rows = view?.rows?.length || 0;
  return rows ? 0.1 * (rows - 1) + Math.max(0.25, Math.max(...view.rows.map(r => rowLen(r))) * PER_CHAR) + GLOW : 0;
}
