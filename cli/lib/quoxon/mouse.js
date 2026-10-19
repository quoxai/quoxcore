/**
 * QUOXON-MOUSE (owner 2026-10-15: "when I click on '◆ QLOOP-ENGINE' enter /say [slot]", "select a chunk of text I
 * typed and delete it"). Optional, OFF by default: mouse tracking makes the terminal send clicks to Quox, so
 * selecting or copying text then needs Shift+drag in most terminals (said when it is turned on).
 *
 * Pure parts only (the app wires them):
 * - MOUSE_ON / MOUSE_OFF: SGR button tracking with drag (1000 + 1002 + 1006). Never any-motion (1003).
 * - createScreenMirror: what Ink has put on the screen, as plain lines. Fed every string Ink writes (term.js), it
 *   models exactly Ink's output: text, newlines, eraseLines (frame repaints) and clear-terminal. The live frame is
 *   the last write; everything above it is static history. Wrapping is applied at the current width when read, so
 *   a resize reflows it the way the terminal does.
 * - screenHit: a click's screen row -> the mirror line under it. Rows are counted up from the cursor (which Ink
 *   always leaves on the line after the frame), read with a cursor position report (DSR) at click time, so the
 *   map holds whether the frame sits at the bottom of a full screen or halfway down a fresh one.
 * - classifyClick: what that line is (a ◆ sender, a card's answer key label, the shared ask's y/N/c).
 * - composerIndexAt: a click in the composer rows -> a buffer index, through Ink's word wrap.
 */
import { graphemes, composerFrom } from './textBuffer.js';

export const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';
export const DSR = '\x1b[6n';
/** Two presses on the same cell within this window are a double-click. */
export const DOUBLE_MS = 400;
/** How long a click waits for the terminal's cursor report before it is dropped. */
export const DSR_TIMEOUT_MS = 400;

export function mouseOnNote() {
  return 'Mouse on. Click a ◆ sender to reply, click a card\'s y / n / c to answer, click or drag in your draft to place the cursor or select (Backspace deletes, typing replaces, double-click selects a word). While it is on your terminal sends clicks and the wheel to Quox: hold Shift to select or copy text (Option on macOS Terminal and iTerm2), and use Shift+wheel or the scrollbar to scroll back. /mouse off returns all of it.';
}

// ---- cell widths --------------------------------------------------------------------------------
const WIDE = /\p{Extended_Pictographic}/u;
const EAW = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
/** Terminal cells one grapheme takes: 2 for emoji presentation and East Asian wide, else 1. */
export function cellWidth(g) {
  const cp = g.codePointAt(0);
  if (EAW.test(g)) return 2;
  if (WIDE.test(g) && (cp >= 0x1f000 || g.includes('️'))) return 2;
  return 1;
}
const cellsOf = (s) => graphemes(String(s)).reduce((n, x) => n + cellWidth(x.text), 0);
/** Grapheme index in `gs` covering 0-based cell `col` (gs.length when past the end). */
function cellToIndex(gs, col) {
  let at = 0;
  for (let i = 0; i < gs.length; i++) { const w = cellWidth(gs[i].text); if (col < at + w) return i; at += w; }
  return gs.length;
}
/** 1-based start cell of grapheme index `i`. */
function indexToCell(gs, i) { let at = 1; for (let k = 0; k < i && k < gs.length; k++) at += cellWidth(gs[k].text); return at; }

// ---- screen mirror ------------------------------------------------------------------------------
const ANSI_RE = /\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;
const ERASE_RE = /^((?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G)/;
const CLEAR_RE = /\x1b\[2J|\x1bc/;

/** Wrap one plain line into rows of at most `cols` cells (what the terminal shows). */
function wrapRows(line, cols) {
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

export function createScreenMirror({ columns = () => null, cap = 3000 } = {}) {
  let lines = ['']; // logical lines; the last one is the cursor line
  let frameLen = 0; // logical lines written by the last write (the live frame, once Ink has written it)
  const append = (text) => {
    const parts = text.replace(ANSI_RE, '').replace(/\r/g, '').split('\n');
    lines[lines.length - 1] += parts[0];
    for (let i = 1; i < parts.length; i++) lines.push(parts[i]);
    if (lines.length > cap) lines = lines.slice(lines.length - cap);
    return parts.length - 1;
  };
  const m = {
    /** One string Ink wrote, before any diffing. */
    write(chunk) {
      let s = String(chunk);
      const clear = s.search(CLEAR_RE);
      if (clear >= 0) {
        const all = [...s.matchAll(/\x1b\[2J|\x1b\[3J|\x1b\[H|\x1bc/g)];
        const last = all[all.length - 1];
        s = s.slice(last.index + last[0].length);
        lines = ['']; frameLen = 0;
      }
      const e = ERASE_RE.exec(s);
      if (e) {
        const n = (e[1].match(/\x1b\[2K/g) || []).length;
        const drop = Math.min(n - 1, lines.length - 1);
        lines.length -= drop;
        lines[lines.length - 1] = '';
        s = s.slice(e[1].length);
      }
      const plain = s.replace(ANSI_RE, '');
      if (!plain) return;
      const rows = append(s);
      if (rows > 0) frameLen = rows;
    },
    /** Test helper: Ink repainting its frame as these lines. */
    frame(fl) { m.write(`\x1b[2K\x1b[G${fl.join('\n')}\n`); },
    /** Raw output we cannot place (a hand-over, a child on the terminal): forget what is above. */
    reset() { lines = ['']; frameLen = 0; },
    /** -> { rows, frameStart, staticRows, frameRows }: wrapped at the current width, cursor line excluded. */
    snapshot() {
      const cols = columns();
      const body = lines.slice(0, -1);
      const fl = Math.min(frameLen, body.length);
      const stat = body.slice(0, body.length - fl).flatMap(l => wrapRows(l, cols));
      const fr = body.slice(body.length - fl).flatMap(l => wrapRows(l, cols));
      return { rows: [...stat, ...fr], frameStart: stat.length, staticRows: stat, frameRows: fr };
    }
  };
  return m;
}

/** A click at 1-based (x, y) with the cursor on screen row `cursorRow` -> the line under it, or null. */
export function screenHit(snap, cursorRow, x, y) {
  if (!snap || !(cursorRow > 0)) return null;
  const idx = snap.rows.length - (cursorRow - y);
  if (y >= cursorRow || idx < 0 || idx >= snap.rows.length) return null;
  return {
    text: snap.rows[idx], col: x, inFrame: idx >= snap.frameStart,
    frameRow: idx - snap.frameStart, frameLines: snap.rows.slice(snap.frameStart), rowsBelow: snap.rows.slice(idx + 1)
  };
}

// ---- what was clicked ---------------------------------------------------------------------------
const SENDER_RE = /^\s*◆ (\S+)( \(no reply address\))?/;
const CARD_KEY_RE = /(?<![\w/])([ync]) (approve|deny|chat|yes)(?![\w])/g;
const ASK_KEYS_RE = /(?<![\w/])(y|run)\/(N)\/(c)\s*$/;
const isAskRow = (r) => /^\s*▶ /.test(r) && (ASK_KEYS_RE.test(r) || /\b[ync] (approve|deny|chat)\b/.test(r));

/**
 * -> { kind: 'sender', slot, who? } | { kind: 'key', key: 'y'|'n'|'c'|'run', source: 'approval'|'ask' } | null.
 * A key needs the click ON its label. A card's labels count only in the live frame (a card is never answered from
 * scrollback); an ask's y/N/c only when no newer ask sits below it on screen.
 */
export function classifyClick(hit) {
  if (!hit || typeof hit.text !== 'string') return null;
  const t = hit.text;
  const gs = graphemes(t);
  const s = SENDER_RE.exec(t);
  if (s) return s[2] ? { kind: 'sender', slot: null, who: s[1] } : { kind: 'sender', slot: s[1].toLowerCase() };
  const within = (from, len) => {
    const gi = graphemes(t.slice(0, from)).length;
    const a = indexToCell(gs, gi); const b = a + cellsOf(t.slice(from, from + len));
    return hit.col >= a && hit.col < b;
  };
  if (hit.inFrame) {
    CARD_KEY_RE.lastIndex = 0;
    let m;
    while ((m = CARD_KEY_RE.exec(t))) if (within(m.index, m[0].length)) return { kind: 'key', key: m[1], source: 'approval' };
  }
  const k = ASK_KEYS_RE.exec(t);
  if (k && /^\s*▶ /.test(t)) {
    if ((hit.rowsBelow || []).some(isAskRow)) return null;
    const base = k.index + k[0].indexOf(k[1]);
    const yPos = base, nPos = yPos + k[1].length + 1, cPos = nPos + 2;
    if (within(yPos, k[1].length)) return { kind: 'key', key: k[1] === 'run' ? 'run' : 'y', source: 'ask' };
    if (within(nPos, 1)) return { kind: 'key', key: 'n', source: 'ask' };
    if (within(cPos, 1)) return { kind: 'key', key: 'c', source: 'ask' };
  }
  return null;
}

// ---- the composer -------------------------------------------------------------------------------
const isRule = (r) => /^\s*─/.test(r || '');
const isPrompt = (r) => /^› /.test(r || '') || r === '›';

/**
 * A click on frame row `row` (0-based), 1-based column `col` -> the buffer index under it, or null when the row is
 * not one of the composer's. The composer is the "› " row right under a rule, down to the next rule.
 */
export function composerIndexAt(frameLines, row, col, buf) {
  let top = -1;
  for (let i = frameLines.length - 1; i >= 1; i--) if (isPrompt(frameLines[i]) && isRule(frameLines[i - 1])) { top = i; break; }
  if (top < 0 || row < top) return null;
  let bottom = top;
  while (bottom < frameLines.length && !isRule(frameLines[bottom])) bottom++;
  if (row >= bottom) return null;
  if (!buf.text) return 0;
  const lines = buf.text.split('\n');
  const starts = []; { let o = 0; for (const l of lines) { starts.push(o); o += l.length + 1; } }
  const from = composerFrom(buf);
  let r = top;
  for (let li = from; li < lines.length && r < bottom; li++) {
    const T = graphemes(lines[li]);
    let p = 0; let first = true;
    const rest = () => T.slice(p).some(g => !/\s/.test(g.text)); // trailing spaces never take a row of their own
    while (r < bottom && (first || rest())) {
      const R = graphemes(String(frameLines[r]).replace(/\s+$/, '')).slice(2);
      while (!first && p < T.length && /\s/.test(T[p].text) && R.length && !/\s/.test(R[0].text)) p++;
      const take = Math.min(R.length, T.length - p);
      if (r === row) {
        const gi = Math.min(T.length, p + Math.min(cellToIndex(R, Math.max(0, col - 3)), take));
        return starts[li] + (gi < T.length ? T[gi].index : lines[li].length);
      }
      p += Math.max(take, 0); r++; first = false;
      if (take <= 0) break;
    }
  }
  return buf.text.length;
}

