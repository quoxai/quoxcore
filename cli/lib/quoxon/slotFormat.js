/**
 * SLOT-RUN A (owner 2026-10-16, about a slot message that arrived as a wrapped wall of text around a long
 * shell command: "messy needs a format, structure, styling"). Incoming slot message bodies render light
 * markdown: paragraphs, - bullets, **bold**, `inline code` and fenced blocks.
 *
 * Code is never wrapped mid-token. A long inline command is lifted into its own block; a block line that does
 * not fit breaks ONLY at unquoted whitespace and ends in " \" (shell line continuation), so a copied block is
 * still the same command. A single token longer than the row hard-breaks with a visible " ↩".
 *
 * Pure layout: rows of segments { t, role, bold? }. render.js paints them; no grey roles (owner rule).
 */
import { graphemes } from './textBuffer.js';

export const CONT = ' \\';
export const HARD = ' ↩';
export const GUTTER = '│ ';
export const LONG_INLINE = 32; // an inline code span longer than this gets its own block

const len = (s) => graphemes(String(s)).length;

/** Where a line may break: unquoted, unescaped whitespace before any unquoted # comment. */
function safeBreaks(chars) {
  const safe = new Array(chars.length).fill(false);
  let q = null; let comment = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (comment) continue;
    if (q === "'") { if (ch === "'") q = null; continue; }
    if (q === '"') { if (ch === '\\') i++; else if (ch === '"') q = null; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(chars[i - 1]))) { comment = true; continue; }
    if (/\s/.test(ch)) safe[i] = true;
  }
  return safe;
}

/** One command line as rows of at most `width` columns. Continuation rows are indented two spaces. */
export function wrapShell(line, width) {
  const w = Math.max(12, width);
  const chars = [...String(line)];
  if (chars.length <= w) return [chars.join('')];
  const safe = safeBreaks(chars);
  const out = [];
  let start = 0;
  for (;;) {
    const indent = out.length ? '  ' : '';
    const avail = w - indent.length;
    if (chars.length - start <= avail) { out.push(indent + chars.slice(start).join('')); break; }
    const lim = avail - CONT.length;
    let cut = -1;
    for (let i = start + lim; i > start; i--) if (safe[i]) { cut = i; break; }
    if (cut > start) {
      out.push(indent + chars.slice(start, cut).join('').replace(/\s+$/, '') + CONT);
      start = cut;
      while (start < chars.length && safe[start]) start++;
    } else {
      const n = avail - HARD.length;
      out.push(indent + chars.slice(start, start + n).join('') + HARD);
      start += n;
    }
  }
  return out;
}

/** Inline runs of one line: plain text, **bold**, `code`. */
function inlineRuns(text) {
  const out = [];
  const re = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*/g;
  let last = 0; let m;
  const s = String(text);
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ kind: 'text', t: s.slice(last, m.index) });
    if (m[1]) out.push({ kind: 'code', t: m[2].trim() });
    else out.push({ kind: 'bold', t: m[3] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ kind: 'text', t: s.slice(last) });
  return out;
}

/** Block structure: code (fenced, `$ ` lines, long inline spans), bullets, paragraphs, gaps. */
function blocks(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const push = (b) => {
    if (b.type === 'gap' && (!out.length || out[out.length - 1].type === 'gap')) return;
    out.push(b);
  };
  for (let i = 0; i < src.length; i++) {
    const line = src[i];
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const lines = [];
      for (i++; i < src.length && !src[i].trim().startsWith(fence[1]); i++) lines.push(src[i]);
      push({ type: 'code', lines });
      continue;
    }
    if (/^\s*\$ \S/.test(line)) {
      const prev = out[out.length - 1];
      if (prev?.type === 'code' && prev.dollar) prev.lines.push(line.trim()); else push({ type: 'code', lines: [line.trim()], dollar: true });
      continue;
    }
    if (!line.trim()) { push({ type: 'gap' }); continue; }
    const bullet = /^\s*(?:[-*•]|(\d+[.)]))\s+(.*)$/.exec(line);
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    const kind = bullet ? 'bullet' : 'para';
    const body = bullet ? bullet[2] : heading ? `**${heading[1]}**` : line;
    const mark = bullet ? (bullet[1] ? `${bullet[1]} ` : '• ') : '';
    // A long inline command is lifted out into its own block between the prose around it.
    let pending = [];
    let first = true;
    const flush = () => {
      if (!pending.length) return;
      if (pending.some(r => r.kind !== 'text' || r.t.trim())) push({ type: kind, runs: pending, mark: first ? mark : (mark ? '  ' : '') });
      first = false; pending = [];
    };
    for (const r of inlineRuns(body)) {
      if (r.kind === 'code' && len(r.t) > LONG_INLINE) { flush(); push({ type: 'code', lines: [r.t] }); first = false; }
      else pending.push(r);
    }
    flush();
  }
  while (out.length && out[out.length - 1].type === 'gap') out.pop();
  return out;
}

/** Word-wrap inline runs to `width`; code spans are unbreakable atoms (hard-split only if wider than the row). */
function wrapRuns(runs, width, role, prefix) {
  const atoms = [];
  for (const r of runs) {
    if (r.kind === 'code') { atoms.push({ t: r.t, role: 'code', sp: /^\s/.test(r.t) }); continue; }
    const parts = r.t.split(/(\s+)/);
    for (const p of parts) {
      if (!p) continue;
      if (/^\s+$/.test(p)) { atoms.push({ space: true }); continue; }
      atoms.push({ t: p, role, bold: r.kind === 'bold' || undefined });
    }
  }
  const rows = [];
  let cur = []; let w = 0; let gap = false;
  const ind = len(prefix);
  const room = Math.max(8, width - ind);
  const add = (seg) => {
    const last = cur[cur.length - 1];
    if (last && last.role === seg.role && last.bold === seg.bold) last.t += seg.t; else cur.push({ ...seg });
  };
  const newRow = () => { rows.push(cur); cur = []; w = 0; };
  for (const a of atoms) {
    if (a.space) { gap = true; continue; }
    const sep = cur.length && gap ? 1 : 0; // runs that touch (`a`**b**) stay touching

    let t = a.t;
    if (w + sep + len(t) > room && cur.length) newRow();
    else if (sep) { add({ t: ' ', role, bold: undefined }); w += 1; }
    while (len(t) > room) { const g = graphemes(t); add({ t: g.slice(0, room - w).join(''), role: a.role, bold: a.bold }); t = g.slice(room - w).join(''); newRow(); }
    add({ t, role: a.role, bold: a.bold }); w += len(t);
    gap = false;
  }
  if (cur.length) rows.push(cur);
  return rows.map((r, i) => (prefix ? [{ t: i === 0 ? prefix : ' '.repeat(ind), role: 'bullet1' }, ...r] : r));
}

/** A code block's rows: gutter, the code, and the continuation marker in the label colour. */
export function codeRows(lines, width) {
  const rows = [];
  for (const line of lines) {
    for (const piece of wrapShell(line, Math.max(12, width - len(GUTTER)))) {
      const mk = piece.endsWith(CONT) ? CONT : piece.endsWith(HARD) ? HARD : '';
      const body = mk ? piece.slice(0, -mk.length) : piece;
      rows.push([{ t: GUTTER, role: 'label' }, { t: body || ' ', role: 'code' }, ...(mk ? [{ t: mk, role: 'label' }] : [])]);
    }
  }
  return rows;
}

/** The body of a slot message as rows of segments, at most `width` columns each. */
export function formatSlotBody(text, width, { role = 'text' } = {}) {
  const rows = [];
  for (const b of blocks(text)) {
    if (b.type === 'gap') rows.push([]);
    else if (b.type === 'code') rows.push(...codeRows(b.lines, width));
    else rows.push(...wrapRuns(b.runs, width, role, b.mark));
  }
  return rows;
}

/** Plain text of each row (tests, NO_COLOR). */
export const rowsText = (rows) => rows.map(r => r.map(s => s.t).join(''));

/** A short plain one-liner keeps the chat shape: on the header line after the time. */
export function inlineable(text, room) {
  const t = String(text ?? '');
  return !/[\n`]|\*\*/.test(t) && !/^\s*(?:[-*•]\s|\d+[.)]\s|\$ |#{1,6}\s)/.test(t) && len(t) <= room;
}
