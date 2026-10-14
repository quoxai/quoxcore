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
  return { text, cursor: text.length, undo: [], redo: [], pastes: {}, pasteSeq: 0 };
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

export function normalizeNewlines(t) { return String(t).replace(/\r\n?/g, '\n'); }

/** Build the collapsed form of a paste, or null when it is small enough to inline. */
export function shouldCollapse(text) {
  const lines = text.split('\n').length;
  return text.length > PASTE_CHAR_LIMIT || lines > PASTE_LINE_LIMIT;
}

export function bufferReducer(s, a) {
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
    case 'left': return { ...s, cursor: prevBoundary(s.text, s.cursor) };
    case 'right': return { ...s, cursor: nextBoundary(s.text, s.cursor) };
    case 'home': return { ...s, cursor: lineCol(s.text, s.cursor).start };
    case 'end': {
      const nl = s.text.indexOf('\n', s.cursor);
      return { ...s, cursor: nl === -1 ? s.text.length : nl };
    }
    case 'up': case 'down': {
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
