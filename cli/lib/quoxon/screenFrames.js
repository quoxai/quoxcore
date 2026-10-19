/**
 * SCREEN-FRAMES: the screen as the owner saw it, in the local dev transcript.
 *
 * The owner runs quox over a plain SSH tty, so nothing outside the process can capture what was on screen. This
 * records it from the inside: every string Ink writes is handed to tap() (term.js, the same feed the mouse mirror
 * gets, before line diffing), which only queues it. On a debounce timer the queue is replayed into a styled mirror,
 * the visible screen (the last `rows` rows, wrapped at the terminal width) is cut out as plain text, and ONE
 * `{ t: 'screen', cols, rows, text, colors }` record is written when it has settled and differs from the last one.
 *
 * - Settled: no write for SCREEN_DEBOUNCE_MS, or (while a spinner keeps repainting) the same normalised text across
 *   a full debounce window. normalizeScreen() hides braille spinners and elapsed timers, so those never count as a
 *   change on their own.
 * - Local only: it goes to the transcript file and nowhere else. On whenever dev transcripts are on;
 *   QUOX_SCREEN_FRAMES=0 turns it off.
 * - The timer is unref'd (it never keeps the process alive) and stop() clears it, recording the final screen.
 */
import { graphemes } from './textBuffer.js';
import { cellWidth } from './mouse.js';
import { DARK, LIGHT } from './theme.js';
import { isGrey } from './palette.js';

export const SCREEN_DEBOUNCE_MS = 1200;
export const MAX_SCREEN_TEXT = 16 * 1024;
const MAX_LINES = 1000;     // logical lines kept by the mirror (a screen is far fewer)
const MAX_PENDING = 4000;   // queued writes before they are folded in early (a runaway writer, never normal use)

export function screenFramesEnabled(env = process.env) {
  return env.QUOX_SCREEN_FRAMES !== '0';
}

const ANSI_RE = /\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;
const ERASE_RE = /^((?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G)/;
const CLEAR_RE = /\x1b\[2J|\x1bc/;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

/** A mirror of what Ink drew that keeps the escape codes (so colour use can be read back). Same model as mouse.js. */
export function createStyledMirror({ cap = MAX_LINES } = {}) {
  let lines = [''];
  const append = (text) => {
    const parts = text.replace(/\r/g, '').split('\n');
    lines[lines.length - 1] += parts[0];
    for (let i = 1; i < parts.length; i++) lines.push(parts[i]);
    if (lines.length > cap) lines = lines.slice(lines.length - cap);
  };
  return {
    write(chunk) {
      let s = String(chunk);
      if (CLEAR_RE.test(s)) {
        const all = [...s.matchAll(/\x1b\[2J|\x1b\[3J|\x1b\[H|\x1bc/g)];
        const last = all[all.length - 1];
        s = s.slice(last.index + last[0].length);
        lines = [''];
      }
      const e = ERASE_RE.exec(s);
      if (e) {
        const n = (e[1].match(/\x1b\[2K/g) || []).length;
        lines.length -= Math.min(n - 1, lines.length - 1);
        lines[lines.length - 1] = '';
        s = s.slice(e[1].length);
      }
      if (!stripAnsi(s)) return;
      append(s);
    },
    reset() { lines = ['']; },
    lines: () => lines.slice()
  };
}

/** Text with the parts that move on their own (spinners, timers, the activity decode, rule markers) folded, for change detection only. */
export function normalizeScreen(text) {
  return String(text)
    .replace(/[⠀-⣿]/g, '⠿')
    .replace(/[\uff61-\uff9f]/g, '?')                 // half-width katakana: the activity word's decode animation
    .replace(/[^\s·]*…/g, '*…')                       // ...and the word it is decoding into
    .replace(/[─━┼◆●○◇]+/g, '─')                      // progress markers travelling along the rule
    .replace(/\b\d+:\d{2}(?::\d{2})?\b/g, '#:##')
    .replace(/\b(?:\d+h\s?)?(?:\d+m\s?)?\d+(?:\.\d+)?(?:ms|s)\b/g, '#s')
    .replace(/\b\d+m\b(?=\s|$|[),.])/g, '#m');
}

// ---- colour use ---------------------------------------------------------------------------------
// The client's "dim" is mostly a theme COLOUR (muted / placeholder / quiet), not SGR 2, so rows are classed by the
// theme role they are painted in (both tables, either background), plus a plain grey test for anything else.
const FAMILY = { muted: 'dim', dim: 'dim', placeholder: 'dim', quiet: 'dim', faint: 'dim',
  ok: 'ok', warn: 'warn', error: 'error', fail: 'error', ask: 'ask', gold: 'gold' };
const PLAIN = new Set(['text', 'value', 'input', 'prose']);
const ROLE_HEX = new Map(); const ROLE_256 = new Map();
for (const table of [DARK, LIGHT]) {
  for (const [role, [hex, i256]] of Object.entries(table)) {
    const fam = FAMILY[role] || (PLAIN.has(role) ? 'plain' : 'color');
    const h = hex.toLowerCase();
    if (!ROLE_HEX.has(h) || FAMILY[role]) ROLE_HEX.set(h, fam);
    ROLE_256.set(i256, ROLE_256.has(i256) && ROLE_256.get(i256) !== fam ? 'color' : fam); // a shared index names no role
  }
}
const toHex = (r, g, b) => `#${[r, g, b].map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('')}`;
const isGrey256 = (n) => n === 8 || (n >= 232 && n <= 250);
const rgbClass = (r, g, b) => { const h = toHex(r, g, b); return ROLE_HEX.get(h) || (isGrey(h) ? 'grey' : 'color'); };
const i256Class = (n) => (isGrey256(n) ? 'grey' : ROLE_256.get(n) || 'color');

/** Style flags used on visible (non-space) text of one raw line: dim, grey, bold, inverse, ok/warn/error/ask/gold, color. */
function lineFlags(raw) {
  const st = { bold: false, dim: false, inverse: false, fg: null };
  const used = new Set();
  const mark = () => {
    if (st.bold) used.add('bold');
    if (st.dim) used.add('dim');
    if (st.inverse) used.add('inverse');
    if (st.fg && st.fg !== 'plain') used.add(st.fg);
  };
  for (const m of raw.matchAll(/\x1b\[([0-9;]*)m|\x1b[^m]*?[@-~]|([^\x1b]+)/g)) {
    if (m[2] != null) { if (/\S/.test(m[2])) mark(); continue; }
    if (m[1] == null) continue;
    const p = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) Object.assign(st, { bold: false, dim: false, inverse: false, fg: null });
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 22) { st.bold = false; st.dim = false; }
      else if (c === 7) st.inverse = true;
      else if (c === 27) st.inverse = false;
      else if (c === 39) st.fg = null;
      else if (c === 90) st.fg = 'grey';
      else if (c === 31 || c === 91) st.fg = 'error';
      else if (c === 32 || c === 92) st.fg = 'ok';
      else if (c === 33 || c === 93) st.fg = 'warn';
      else if ((c >= 34 && c <= 36) || (c >= 94 && c <= 96)) st.fg = 'color';
      else if (c === 30 || c === 37 || c === 97) st.fg = null;
      else if (c === 38 && p[i + 1] === 5) { st.fg = i256Class(p[i + 2]); i += 2; }
      else if (c === 38 && p[i + 1] === 2) { st.fg = rgbClass(p[i + 2], p[i + 3], p[i + 4]); i += 4; }
      else if (c === 48 && (p[i + 1] === 5 || p[i + 1] === 2)) i += p[i + 1] === 5 ? 2 : 4;
    }
  }
  return used;
}

const ranges = (nums) => {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}-${nums[j]}` : String(nums[i])); i = j;
  }
  return out.join(',');
};

/** Raw screen rows -> { dim: '0-2,7', warn: '4', ... }: 0-based visible rows per style, empty styles left out. */
export function colorSummary(rawRows, flagsOf = lineFlags) {
  const by = { dim: [], grey: [], bold: [], inverse: [], ok: [], warn: [], error: [], ask: [], gold: [], color: [] };
  rawRows.forEach((r, i) => { for (const f of (r instanceof Set ? r : flagsOf(r))) by[f].push(i); });
  const o = {};
  for (const k of Object.keys(by)) if (by[k].length) o[k] = ranges(by[k]);
  return o;
}

function wrapPlain(line, cols) {
  if (!(cols > 0)) return [line];
  const gs = graphemes(line);
  if (!gs.length) return [''];
  const out = []; let row = ''; let w = 0;
  for (const g of gs) {
    const cw = cellWidth(g.text);
    if (w + cw > cols) { out.push(row); row = ''; w = 0; }
    row += g.text; w += cw;
  }
  out.push(row);
  return out;
}

/** The visible screen from mirror lines: the last `rows` rows at width `cols`, trailing blank rows dropped. */
export function visibleScreen(lines, { cols, rows }) {
  const body = lines.slice();
  while (body.length && !stripAnsi(body[body.length - 1]).trim()) body.pop();
  const want = rows > 0 ? rows : 50;
  const out = []; // [{ text, flags }] bottom-up
  for (let i = body.length - 1; i >= 0 && out.length < want; i--) {
    const wrapped = wrapPlain(stripAnsi(body[i]), cols);
    const flags = lineFlags(body[i]);
    for (let k = wrapped.length - 1; k >= 0 && out.length < want; k--) out.push({ text: wrapped[k].replace(/\s+$/, ''), flags });
  }
  return out.reverse();
}

/**
 * -> { tap(chunk) (also tap.write / tap.reset), stop() }. `write(rec)` gets each screen record. Never throws into the caller.
 */
export function createScreenRecorder({ write, cols = () => process.stdout.columns, rows = () => process.stdout.rows, timers = globalThis, now = Date.now, debounceMs = SCREEN_DEBOUNCE_MS } = {}) {
  const mirror = createStyledMirror();
  let pending = [];
  let timer = null;
  let lastTap = 0;
  let lastNorm = null;   // normalised text of the last record
  let candidate = null;  // normalised text seen at the last check that was not yet quiet
  let stopped = false;

  const fold = () => {
    const q = pending; pending = [];
    for (const c of q) { if (c === null) mirror.reset(); else mirror.write(c); }
  };
  const arm = (ms) => {
    if (stopped) return;
    timer = timers.setTimeout(check, Math.max(1, ms));
    timer?.unref?.();
  };
  const snapshot = () => {
    fold();
    const c = cols(), r = rows();
    const vis = visibleScreen(mirror.lines(), { cols: c, rows: r });
    let start = 0; let size = 0;
    for (let i = vis.length - 1; i >= 0; i--) { // keep the bottom of the screen inside the cap
      if (size + vis[i].text.length + 1 > MAX_SCREEN_TEXT) { start = i + 1; break; }
      size += vis[i].text.length + 1;
    }
    const kept = vis.slice(start);
    const text = kept.map(v => v.text).join('\n');
    const dropped = vis.slice(0, start).reduce((n, v) => n + v.text.length + 1, 0);
    return { cols: c ?? null, rows: r ?? null, text, colors: colorSummary(kept.map(v => v.flags)), ...(dropped ? { truncated: dropped } : {}) };
  };
  const emit = (snap, norm) => {
    lastNorm = norm; candidate = null;
    try { write({ t: 'screen', ...snap }); } catch { /* capture must never break the client */ }
  };
  function check() {
    timer = null;
    try {
      const snap = snapshot();
      const norm = normalizeScreen(snap.text);
      if (norm === lastNorm) { candidate = null; return; }
      const quietFor = now() - lastTap;
      if (quietFor >= debounceMs || norm === candidate) { emit(snap, norm); return; }
      candidate = norm;
      arm(Math.min(debounceMs, lastTap + debounceMs - now()));
    } catch { /* never throw from a timer */ }
  }
  const queue = (c) => {
    if (stopped) return;
    pending.push(c);
    lastTap = now();
    if (pending.length > MAX_PENDING) { try { fold(); } catch { pending = []; } }
    if (!timer) arm(debounceMs);
  };
  const tap = (chunk) => queue(String(chunk)); // the only work on the write path: queue the string, arm the timer
  tap.write = tap;
  tap.reset = () => queue(null);
  return {
    tap,
    stop() {
      if (stopped) return;
      if (timer) { timers.clearTimeout(timer); timer = null; }
      try { const snap = snapshot(); const norm = normalizeScreen(snap.text); if (snap.text && norm !== lastNorm) emit(snap, norm); } catch { /* ignore */ }
      stopped = true; pending = [];
    }
  };
}
