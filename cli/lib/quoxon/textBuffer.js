/**
 * QUOXON composer text buffer: a pure reducer over { text, cursor, undo, redo,
 * pastes, pasteSeq }. Written for Quox (no third-party code). The pattern is
 * the usual one for Ink editors: all edits are actions, the view is derived.
 *
 * - cursor is a UTF-16 index that always sits on a grapheme boundary
 *   (Intl.Segmenter), so emoji, ZWJ sequences and combining marks move as one.
 * - Large pastes collapse to `[Pasted text #N +L lines]` and expand on send.
 * - Invisible Unicode (zero width, bidi controls, tag characters) is detected
 *   and stripped on Enter with a review round trip (see sanitizeForSend).
 */

const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const PASTE_CHAR_LIMIT = 800;
export const PASTE_LINE_LIMIT = 3;
const UNDO_LIMIT = 100;
const PASTE_RE = /\[Pasted text #(\d+) \+\d+ lines\]/g;

export function initialBuffer(text = '') {
  return { text, cursor: text.length, anchor: null, undo: [], redo: [], pastes: {}, pasteSeq: 0 };
}

/**
 * QUOXON-MOUSE: the composer selection, { from, to } (from < to), or null. A selection is the range between
 * `anchor` (where a drag started) and the cursor; only the mouse sets an anchor.
 */
export function selection(s) {
  if (s?.anchor == null || s.anchor === s.cursor) return null;
  return { from: Math.min(s.anchor, s.cursor), to: Math.max(s.anchor, s.cursor) };
}

/** The word under `idx` for a double-click: a run of non-space characters, or the one space character itself. */
export function wordAt(text, idx) {
  const t = String(text);
  const i = Math.max(0, Math.min(idx, t.length - 1));
  if (!t.length) return { from: 0, to: 0 };
  if (/\s/.test(t[i])) return { from: i, to: nextBoundary(t, i) };
  let a = i; let b = i;
  while (a > 0 && !/\s/.test(t[a - 1])) a--;
  while (b < t.length && !/\s/.test(t[b])) b++;
  return { from: a, to: b };
}

/** Snap an index onto a grapheme boundary (at or before it). */
function snap(text, idx) {
  const i = Math.max(0, Math.min(Number(idx) || 0, text.length));
  return i === text.length ? i : prevBoundary(text, i + 1);
}

/** The selected range widened so it never leaves half a paste placeholder behind. */
function selRange(s, sel) {
  let { from, to } = sel;
  PASTE_RE.lastIndex = 0;
  let m;
  while ((m = PASTE_RE.exec(s.text))) {
    const a = m.index, b = a + m[0].length;
    if (to > a && from < b) { from = Math.min(from, a); to = Math.max(to, b); }
  }
  return { from, to };
}

const EDITS = new Set(['insert', 'newline', 'paste', 'backspace', 'delete', 'deleteWordBack', 'killLineBack', 'killLineForward', 'deleteWordForward']);

/** COMPOSER-EDIT: the selected text, paste placeholders expanded (what Shift selection copies). '' when none. */
export function selectedText(s) {
  const sel = selection(s);
  if (!sel) return '';
  const { from, to } = selRange(s, sel);
  return expandPastes({ text: s.text.slice(from, to), pastes: s.pastes || {} });
}

// ---- COMPOSER-EDIT: words and soft-wrapped rows ------------------------------------------------
const WORD = /[\p{L}\p{N}_]/u;
/** Readline backward-word: skip non-word characters, then the word. */
function wordLeftIndex(t, i) {
  while (i > 0 && !WORD.test(t[i - 1])) i--;
  while (i > 0 && WORD.test(t[i - 1])) i--;
  return i;
}
/** Readline forward-word: skip non-word characters, then the word (lands at its end). */
function wordRightIndex(t, i) {
  while (i < t.length && !WORD.test(t[i])) i++;
  while (i < t.length && WORD.test(t[i])) i++;
  return i;
}
/** Remove [from, to), widened so no paste placeholder is left half cut. */
function cutRange(s, from, to) {
  if (from >= to) return s;
  const r = selRange(s, { from, to });
  return commit(s, { text: s.text.slice(0, r.from) + s.text.slice(r.to), cursor: r.from });
}

const cellW = (g) => (/[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(g) || (/\p{Extended_Pictographic}/u.test(g) && (g.codePointAt(0) >= 0x1f000 || g.includes('\uFE0F'))) ? 2 : 1);
/**
 * The draft as the rows the terminal shows at `width` cells: [{ start, end }] (UTF-16 indices, end exclusive,
 * newline not included). Word wrap like Ink's: a word that does not fit starts a new row, spaces hang at the row
 * end, and a word longer than a row is split hard.
 */
export function visualRows(text, width) {
  const out = [];
  let o = 0;
  for (const line of String(text).split('\n')) {
    if (!(width > 0) || !line.length) { out.push({ start: o, end: o + line.length }); o += line.length + 1; continue; }
    const tokens = line.match(/\s+|\S+/g);
    let rowStart = o; let w = 0; let p = o;
    for (const tok of tokens) {
      const gs = graphemes(tok);
      const tw = gs.reduce((n, g) => n + cellW(g.text), 0);
      if (/^\s/.test(tok) || w + tw <= width) { w += tw; p += tok.length; continue; }
      if (tw <= width) { out.push({ start: rowStart, end: p }); rowStart = p; w = tw; p += tok.length; continue; }
      for (const g of gs) { // longer than a row: split it hard
        const cw = cellW(g.text);
        if (w + cw > width && w > 0) { out.push({ start: rowStart, end: p }); rowStart = p; w = 0; }
        w += cw; p += g.text.length;
      }
    }
    out.push({ start: rowStart, end: o + line.length });
    o += line.length + 1;
  }
  return out;
}
/** Index of the visual row holding `cursor`. A cursor at a soft break sits at the start of the next row. */
function rowOf(rows, cursor) {
  for (let i = rows.length - 1; i >= 0; i--) if (cursor >= rows[i].start) return i;
  return 0;
}
/** COMPOSER-EDIT: is the cursor on the first (`up`) or last (`down`) row the terminal shows? */
export function atVisualEdge(s, dir, width) {
  if (!(width > 0)) {
    return dir === 'up' ? !s.text.slice(0, s.cursor).includes('\n') : !s.text.slice(s.cursor).includes('\n');
  }
  const rows = visualRows(s.text, width);
  const r = rowOf(rows, s.cursor);
  return dir === 'up' ? r === 0 : r === rows.length - 1;
}
function moveVisual(s, dir, width) {
  const rows = visualRows(s.text, width);
  const r = rowOf(rows, s.cursor);
  const t = dir === 'up' ? r - 1 : r + 1;
  if (t < 0 || t >= rows.length) return s;
  const col = graphemes(s.text.slice(rows[r].start, s.cursor)).reduce((n, g) => n + cellW(g.text), 0);
  const row = rows[t];
  const soft = t + 1 < rows.length && rows[t + 1].start === row.end; // the row breaks softly: its end is the next row's start
  const gs = graphemes(s.text.slice(row.start, row.end));
  let at = 0; let idx = row.end;
  for (const g of gs) { const w = cellW(g.text); if (col < at + w) { idx = row.start + g.index; break; } at += w; }
  if (soft && idx >= row.end) idx = prevBoundary(s.text, row.end);
  return { ...s, cursor: idx };
}

export function graphemes(text) {
  return Array.from(seg.segment(text), s => ({ index: s.index, text: s.segment }));
}

/** Boundary strictly before `idx` (0 if none). */
export function prevBoundary(text, idx) {
  let prev = 0;
  for (const s of seg.segment(text)) {
    if (s.index >= idx) break;
    prev = s.index;
  }
  return prev;
}

/** Boundary strictly after `idx` (text.length if none). */
export function nextBoundary(text, idx) {
  for (const s of seg.segment(text)) {
    if (s.index > idx) return s.index;
  }
  return text.length;
}

export function displayWidthOfLine(s) { return graphemes(s).length; }

/** Placeholder range under or touching `idx` when deleting in a direction. */
function placeholderAt(text, from, to) {
  PASTE_RE.lastIndex = 0;
  let m;
  while ((m = PASTE_RE.exec(text))) {
    const a = m.index, b = a + m[0].length;
    if (to > a && from < b) return { a, b };
  }
  return null;
}

function snapshot(s) { return { text: s.text, cursor: s.cursor, pastes: s.pastes, pasteSeq: s.pasteSeq }; }

function commit(s, next) {
  const undo = [...s.undo, snapshot(s)].slice(-UNDO_LIMIT);
  return { ...s, ...next, undo, redo: [] };
}

export function lineCol(text, cursor) {
  const before = text.slice(0, cursor);
  const line = before.split('\n').length - 1;
  const start = before.lastIndexOf('\n') + 1;
  return { line, col: graphemes(text.slice(start, cursor)).length, start };
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function indexAtLineCol(text, line, col) {
  const starts = lineStarts(text);
  const l = Math.max(0, Math.min(line, starts.length - 1));
  const start = starts[l];
  const end = l + 1 < starts.length ? starts[l + 1] - 1 : text.length;
  const gs = graphemes(text.slice(start, end));
  if (col >= gs.length) return end;
  return start + gs[col].index;
}

/** First logical line the composer shows (it shows at most `maxLines`, keeping the cursor line in view). */
export function composerFrom(buf, maxLines = 8) {
  const n = buf.text.split('\n').length;
  if (n <= maxLines) return 0;
  const { line } = lineCol(buf.text, buf.cursor);
  return Math.min(Math.max(0, line - Math.floor(maxLines / 2)), n - maxLines);
}

export function normalizeNewlines(t) { return String(t).replace(/\r\n?/g, '\n'); }

/** Build the collapsed form of a paste, or null when it is small enough to inline. */
export function shouldCollapse(text) {
  const lines = text.split('\n').length;
  return text.length > PASTE_CHAR_LIMIT || lines > PASTE_LINE_LIMIT;
}

export function bufferReducer(s0, a) {
  const sel = selection(s0);
  const s = s0.anchor == null ? s0 : { ...s0, anchor: null };
  if (sel && EDITS.has(a.type)) {
    // QUOXON-MOUSE: Backspace/Delete remove the selection; typing or pasting replaces it. One undo step.
    const { from, to } = selRange(s, sel);
    const cut = { ...s, text: s.text.slice(0, from) + s.text.slice(to), cursor: from };
    if (a.type !== 'insert' && a.type !== 'newline' && a.type !== 'paste') return commit(s, { text: cut.text, cursor: from });
    const next = baseReducer({ ...cut, undo: [] }, a);
    return commit(s, { text: next.text, cursor: next.cursor, pastes: next.pastes, pasteSeq: next.pasteSeq });
  }
  if (sel && a.type === 'left') return { ...s, cursor: sel.from };
  if (sel && a.type === 'right') return { ...s, cursor: sel.to };
  switch (a.type) {
    case 'extend': { // COMPOSER-EDIT: Shift+movement grows the selection from where it started
      const anchor = s0.anchor ?? s0.cursor;
      const moved = baseReducer({ ...s, anchor: null }, { type: a.move, width: a.width });
      return { ...s, cursor: moved.cursor, anchor: moved.cursor === anchor ? null : anchor };
    }
    case 'selectAll': return s.text ? { ...s, anchor: 0, cursor: s.text.length } : s;
    case 'place': return { ...s, cursor: snap(s.text, a.index) };
    case 'select': {
      const anchor = snap(s.text, a.anchor); const cursor = snap(s.text, a.cursor);
      return { ...s, anchor: anchor === cursor ? null : anchor, cursor };
    }
    default: return baseReducer(s, a);
  }
}

function baseReducer(s, a) {
  switch (a.type) {
    case 'insert': {
      const t = normalizeNewlines(a.text);
      if (!t) return s;
      return commit(s, { text: s.text.slice(0, s.cursor) + t + s.text.slice(s.cursor), cursor: s.cursor + t.length });
    }
    case 'newline':
      return bufferReducer(s, { type: 'insert', text: '\n' });
    case 'paste': {
      const t = normalizeNewlines(a.text);
      if (!t) return s;
      if (!shouldCollapse(t)) return bufferReducer(s, { type: 'insert', text: t });
      const n = s.pasteSeq + 1;
      const ph = `[Pasted text #${n} +${t.split('\n').length} lines]`;
      return commit(s, {
        text: s.text.slice(0, s.cursor) + ph + s.text.slice(s.cursor),
        cursor: s.cursor + ph.length,
        pastes: { ...s.pastes, [n]: t },
        pasteSeq: n
      });
    }
    case 'backspace': {
      if (s.cursor === 0) return s;
      const ph = placeholderAt(s.text, prevBoundary(s.text, s.cursor), s.cursor);
      const from = ph ? ph.a : prevBoundary(s.text, s.cursor);
      const to = ph ? Math.max(ph.b, s.cursor) : s.cursor;
      return commit(s, { text: s.text.slice(0, from) + s.text.slice(to), cursor: from });
    }
    case 'delete': {
      if (s.cursor >= s.text.length) return s;
      const nb = nextBoundary(s.text, s.cursor);
      const ph = placeholderAt(s.text, s.cursor, nb);
      const from = ph ? Math.min(ph.a, s.cursor) : s.cursor;
      const to = ph ? ph.b : nb;
      return commit(s, { text: s.text.slice(0, from) + s.text.slice(to), cursor: from });
    }
    case 'deleteWordBack': {
      let i = s.cursor;
      while (i > 0 && /\s/.test(s.text[i - 1])) i--;
      while (i > 0 && !/\s/.test(s.text[i - 1])) i--;
      if (i === s.cursor) return s;
      return commit(s, { text: s.text.slice(0, i) + s.text.slice(s.cursor), cursor: i });
    }
    case 'killLineBack': {
      const { start } = lineCol(s.text, s.cursor);
      const from = start === s.cursor && start > 0 ? start - 1 : start;
      if (from === s.cursor) return s;
      return commit(s, { text: s.text.slice(0, from) + s.text.slice(s.cursor), cursor: from });
    }
    case 'wordLeft': return { ...s, cursor: wordLeftIndex(s.text, s.cursor) };
    case 'wordRight': return { ...s, cursor: wordRightIndex(s.text, s.cursor) };
    case 'killLineForward': { // Ctrl+K: to the end of the line; at the end, join the next line
      const nl = s.text.indexOf('\n', s.cursor);
      const end = nl === -1 ? s.text.length : (nl === s.cursor ? nl + 1 : nl);
      return cutRange(s, s.cursor, end);
    }
    case 'deleteWordForward': return cutRange(s, s.cursor, wordRightIndex(s.text, s.cursor)); // Alt+D
    case 'left': return { ...s, cursor: prevBoundary(s.text, s.cursor) };
    case 'right': return { ...s, cursor: nextBoundary(s.text, s.cursor) };
    case 'home': return { ...s, cursor: lineCol(s.text, s.cursor).start };
    case 'end': {
      const nl = s.text.indexOf('\n', s.cursor);
      return { ...s, cursor: nl === -1 ? s.text.length : nl };
    }
    case 'up': case 'down': {
      if (a.width > 0) return moveVisual(s, a.type, a.width); // COMPOSER-EDIT: through soft-wrapped rows
      const { line, col } = lineCol(s.text, s.cursor);
      const target = a.type === 'up' ? line - 1 : line + 1;
      const count = s.text.split('\n').length;
      if (target < 0 || target >= count) return s;
      return { ...s, cursor: indexAtLineCol(s.text, target, col) };
    }
    case 'undo': {
      if (!s.undo.length) return s;
      const prev = s.undo[s.undo.length - 1];
      return { ...s, ...prev, undo: s.undo.slice(0, -1), redo: [...s.redo, snapshot(s)] };
    }
    case 'redo': {
      if (!s.redo.length) return s;
      const next = s.redo[s.redo.length - 1];
      return { ...s, ...next, redo: s.redo.slice(0, -1), undo: [...s.undo, snapshot(s)] };
    }
    case 'set': {
      const t = normalizeNewlines(a.text ?? '');
      return commit(s, { text: t, cursor: t.length, pastes: a.keepPastes ? s.pastes : {}, pasteSeq: a.keepPastes ? s.pasteSeq : 0 });
    }
    case 'clear':
      return s.text === '' ? s : commit(s, { text: '', cursor: 0, pastes: {}, pasteSeq: 0 });
    default:
      return s;
  }
}

/** Replace placeholders with the pasted text. */
export function expandPastes(s) {
  return s.text.replace(PASTE_RE, (m, n) => (s.pastes[n] !== undefined ? s.pastes[n] : m));
}

// Invisible characters that can hide instructions in pasted text.
const INVISIBLE_RE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-︎﻿ﾠ\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
const PICTO = /\p{Extended_Pictographic}/u;

/**
 * Strip invisible characters. ZWJ (U+200D) is kept only between two
 * pictographs (family/flag emoji); VS16 is kept (not in the set above).
 * Returns { clean, removed: [{ code, count }], total }.
 */
export function stripInvisible(text) {
  const chars = Array.from(text);
  const counts = new Map();
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const isZwj = ch === '‍';
    const keepZwj = isZwj && i > 0 && i + 1 < chars.length && PICTO.test(chars[i - 1]) && PICTO.test(chars[i + 1]);
    if (!keepZwj && INVISIBLE_RE.test(ch)) {
      const code = 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      counts.set(code, (counts.get(code) || 0) + 1);
      continue;
    }
    out += ch;
  }
  const removed = [...counts].map(([code, count]) => ({ code, count }));
  return { clean: out, removed, total: removed.reduce((n, r) => n + r.count, 0) };
}

/**
 * Enter-time check. If anything invisible is present (in typed text or in a
 * collapsed paste), return a cleaned buffer plus a note; the caller must NOT
 * send, so the user reviews the cleaned text and presses Enter again.
 * Otherwise returns { ok: true, text } with pastes expanded.
 */
export function sanitizeForSend(s) {
  const typed = stripInvisible(s.text);
  const pastes = {};
  let total = typed.total;
  const removed = [...typed.removed];
  for (const [k, v] of Object.entries(s.pastes)) {
    const r = stripInvisible(v);
    pastes[k] = r.clean;
    total += r.total;
    removed.push(...r.removed);
  }
  if (total === 0) return { ok: true, text: expandPastes(s) };
  const merged = new Map();
  for (const r of removed) merged.set(r.code, (merged.get(r.code) || 0) + r.count);
  const detail = [...merged].map(([c, n]) => (n > 1 ? `${c} x${n}` : c)).join(', ');
  const cursor = Math.min(s.cursor, typed.clean.length);
  return {
    ok: false,
    buffer: { ...s, text: typed.clean, cursor, pastes },
    note: `Removed ${total} invisible character${total === 1 ? '' : 's'} (${detail}). Review, then press Enter again to send.`
  };
}
