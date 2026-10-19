/**
 * Terminal markdown for QUOXON. `marked` supplies the LEXER only; every token is
 * rendered by our own Ink components in the Quox style (no marked-terminal).
 *
 * Streaming contract:
 *   splitSettled(text) -> { settled, rest }   settled = complete top-level blocks
 *                                             (safe to move to <Static>), rest = the
 *                                             unfinished tail (re-rendered live).
 *   healInline(text)                          hides half-typed syntax in the live tail
 *                                             (`**bo`, `` `co ``, `[txt](ht`).
 *   An unclosed ``` fence is a single code token to the end of text, so it renders
 *   as code while streaming and never as raw backticks.
 */
import React from 'react';
import { Box, Text, Transform } from 'ink';
import { graphemes } from './textBuffer.js';
import { c, mono, gradient, bulletRole } from './theme.js';

const h = React.createElement;

import { lex, splitSettled } from './markdownSettle.js';

export { lex, splitSettled }; // QUOXON-LATENCY: defined in markdownSettle.js so --print never loads Ink

export function healInline(text) {
  let t = text;
  const fence = (t.match(/^ {0,3}(```|~~~)/gm) || []).length;
  if (fence % 2 === 1) return t; // inside an open fence: leave verbatim, it renders as code
  const cut = (i) => { t = t.slice(0, i); };
  const ticks = (t.match(/`/g) || []).length;
  if (ticks % 2 === 1) cut(t.lastIndexOf('`'));
  const bold = t.split('**').length - 1;
  if (bold % 2 === 1) cut(t.lastIndexOf('**'));
  const tilde = t.split('~~').length - 1;
  if (tilde % 2 === 1) cut(t.lastIndexOf('~~'));
  const lb = t.lastIndexOf('[');
  if (lb >= 0 && !/\]\([^)]*\)/.test(t.slice(lb)) && /^\[[^\]]*(\]\(?[^)\s]*)?$/.test(t.slice(lb))) cut(lb);
  return t;
}

// ---- wrapped text ------------------------------------------------------------------------------
/**
 * Ink wraps with wrap-ansi `trim: false`: when a row fills the width exactly, the space before the next
 * word starts the continuation row (" AI agents."). Drop that one space on wrapped rows (index > 0),
 * after any leading colour codes. Width is unchanged, so layout and row counts are unaffected.
 */
export const dropLeadSpace = (line, i) => (i > 0 ? line.replace(/^((?:\x1b\[[0-9;]*m)*) /, '$1') : line);
/** <Text> whose wrapped continuation rows never start with a stray space. */
export const WText = (props) => h(Transform, { transform: dropLeadSpace }, h(Text, props));

// ---- hyperlinks (OSC 8) --------------------------------------------------------------------------
export function supportsHyperlinks(env = process.env, isTTY = Boolean(process.stdout?.isTTY)) {
  if (!isTTY || env.NO_COLOR || env.QUOX_HYPERLINKS === '0') return false;
  if (env.QUOX_HYPERLINKS === '1') return true;
  if (env.KITTY_WINDOW_ID || env.WT_SESSION) return true;
  if (['iTerm.app', 'WezTerm', 'vscode', 'ghostty'].includes(env.TERM_PROGRAM)) return true;
  return Number(env.VTE_VERSION) >= 5000;
}
const osc8 = (url, text) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

// ---- inline ----------------------------------------------------------------------------------
export function inlineText(tokens = []) {
  return tokens.map(t => {
    if (t.tokens) return inlineText(t.tokens);
    if (t.type === 'br') return ' ';
    return t.text ?? t.raw ?? '';
  }).join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** A heading word painted sky -> indigo -> violet, bold (plain bold under NO_COLOR). */
export const Heading = ({ text, underline = false }) => h(Text, { bold: true, underline },
  ...(mono() ? [String(text)] : gradient(text).map((g, i) => h(Text, { key: i, color: g.color }, g.ch))));

/** Prose with numbers and quantities picked out in the number role. Characters unchanged. */
const NUM = /(?<![\w.#/-])\d+(?:[.,:-]\d+)*(?:%|ms|s|k|m|h|d|x|KB|MB|GB)?(?!\w)/g;
export function numberRuns(text, key = 'n') {
  const s = String(text);
  if (mono()) return [s];
  const out = [];
  let i = 0;
  for (const m of s.matchAll(NUM)) {
    if (m.index > i) out.push(s.slice(i, m.index));
    out.push(h(Text, { key: `${key}#${m.index}`, color: c('number') }, m[0]));
    i = m.index + m[0].length;
  }
  if (i < s.length) out.push(s.slice(i));
  return out;
}

const unesc = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function inline(tokens = [], style = {}, key = 'i') {
  return tokens.map((t, i) => {
    const k = `${key}.${i}`;
    switch (t.type) {
      case 'strong': return h(Text, { key: k, bold: true, color: c('value') }, ...inline(t.tokens, style, k));
      case 'em': return h(Text, { key: k, italic: true }, ...inline(t.tokens, style, k));
      case 'del': return h(Text, { key: k, strikethrough: true }, ...inline(t.tokens, style, k));
      case 'codespan': return mono()
        ? h(Text, { key: k }, '`' + unesc(t.text) + '`')
        : h(Text, { key: k, color: c('code'), backgroundColor: c('codeBg') }, ' ' + unesc(t.text) + ' ');
      case 'br': return h(Text, { key: k }, '\n');
      case 'link': {
        const label = inlineText(t.tokens) || t.href;
        const shown = supportsHyperlinks() ? osc8(t.href, label) : label;
        return h(Text, { key: k }, h(Text, { color: c('sky'), underline: true }, shown),
          label !== t.href ? h(Text, { color: c('muted') }, ` (${t.href})`) : null);
      }
      case 'image': return h(Text, { key: k, color: c('dim') }, `[image: ${t.text || t.href}]`);
      case 'escape': return h(Text, { key: k }, t.text);
      case 'html': return h(Text, { key: k, color: c('dim') }, t.text);
      case 'text': return t.tokens ? h(Text, { key: k }, ...inline(t.tokens, style, k)) : h(Text, { key: k }, ...numberRuns(unesc(t.text), k));
      default: return h(Text, { key: k }, unesc(t.text ?? t.raw ?? ''));
    }
  });
}

// ---- tables ----------------------------------------------------------------------------------
const w = (s) => graphemes(s).length;
const padTo = (s, n) => s + ' '.repeat(Math.max(0, n - w(s)));

/** Hard-wrap plain text to `width` columns at word boundaries (long words split). Never drops text. Always >= 1 line. */
export function wrapCell(text, width) {
  const width_ = Math.max(1, width);
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let g = graphemes(word).map(x => x.text);
      if (cur && w(cur) + 1 + g.length <= width_) { cur += ' ' + word; continue; }
      if (cur) { out.push(cur); cur = ''; }
      while (g.length > width_) { out.push(g.slice(0, width_).join('')); g = g.slice(width_); }
      cur = g.join('');
    }
    out.push(cur);
  }
  return out;
}

/**
 * Plain-text table layout: { mode: 'grid'|'vertical', lines: [{ text, head?, rule? }] }. Pure, for tests.
 * Grid when it fits, else vertical key/value blocks whose values wrap under a hanging indent. No cell is ever truncated
 * (TUI-UX #3: the grounding warning named an id that sat in a clipped cell).
 */
export function layoutTable(header, rows, cols) {
  const n = header.length;
  const widths = header.map((hd, i) => Math.max(w(hd), ...rows.map(r => w(r[i] ?? '')), 1));
  const total = widths.reduce((a, b) => a + b, 0) + 3 * (n - 1);
  const gridLines = (ws) => {
    const cellLines = (r) => {
      const cells = r.map((cell, i) => wrapCell(cell ?? '', ws[i]));
      const h_ = Math.max(...cells.map(x => x.length));
      return Array.from({ length: h_ }, (_, k) => cells.map((x, i) => padTo(x[k] ?? '', ws[i])).join(' │ ').replace(/\s+$/, ''));
    };
    const rule = ws.map(x => '─'.repeat(x)).join('─┼─');
    return [...cellLines(header).map(text => ({ text, head: true })), { text: rule, rule: true }, ...rows.flatMap(r => cellLines(r).map(text => ({ text })))];
  };
  if (total <= cols) return { mode: 'grid', lines: gridLines(widths) };
  // vertical key: value, one block per row; values wrap under a hanging indent
  const lines = [];
  const keyW = Math.min(Math.max(...header.map(w)), Math.floor(cols / 3));
  const valW = Math.max(8, cols - keyW - 2);
  rows.forEach((r, ri) => {
    if (ri) lines.push({ text: '' });
    header.forEach((hd, i) => {
      const keyLines = wrapCell(hd, keyW);
      const val = wrapCell(r[i] ?? '', valW);
      const count = Math.max(keyLines.length, val.length);
      for (let k = 0; k < count; k++) lines.push({ text: `${padTo(keyLines[k] ?? '', keyW)}  ${val[k] ?? ''}`.replace(/\s+$/, ''), key: k === 0 ? keyW : undefined });
    });
  });
  return { mode: 'vertical', lines };
}

function Table({ t, cols }) {
  const header = t.header.map(x => inlineText(x.tokens));
  const rows = t.rows.map(r => r.map(x => inlineText(x.tokens)));
  const lay = layoutTable(header, rows, cols);
  return h(Box, { flexDirection: 'column' }, ...lay.lines.map((l, i) => h(Text, {
    key: i, bold: l.head, color: l.rule ? c('muted') : (l.head ? c('label') : undefined), wrap: 'wrap'
  }, l.text || ' ')));
}

// ---- blocks ----------------------------------------------------------------------------------
const rule = (cols, label) => {
  if (!label) return '─'.repeat(cols);
  const lead = `── ${label} `;
  return lead + '─'.repeat(Math.max(0, cols - w(lead)));
};

/** Fenced code top rule: dim teal line, the language label in the icon role. Same characters as rule(). */
function codeRule(cols, label) {
  const line = rule(cols, label);
  if (!label) return h(Text, { color: c('codeRule') }, line);
  return h(Text, null, h(Text, { color: c('codeRule') }, '── '), h(Text, { color: c('icon') }, label), h(Text, { color: c('codeRule') }, line.slice(3 + label.length)));
}

function List({ t, cols, depth }) {
  const start = typeof t.start === 'number' ? t.start : 1;
  return h(Box, { flexDirection: 'column' }, ...t.items.map((it, i) => {
    const marker = t.ordered ? `${start + i}.` : (depth % 2 ? '◦' : '•');
    const mw = w(marker) + 1;
    return h(Box, { key: i },
      h(Box, { width: mw, flexShrink: 0 }, h(Text, { color: c(bulletRole(depth)) }, marker)),
      h(Box, { flexDirection: 'column', flexGrow: 1, flexShrink: 1 }, ...blocks(it.tokens, cols - mw, depth + 1, `li${i}`)));
  }));
}

function blocks(tokens = [], cols, depth = 0, key = 'b') {
  const out = [];
  tokens.forEach((t, i) => {
    const k = `${key}.${i}`;
    switch (t.type) {
      case 'space': return;
      case 'heading': {
        out.push(h(Box, { key: k, marginTop: depth ? 0 : 1 }, h(Transform, { transform: dropLeadSpace }, h(Heading, { text: inlineStr(t.tokens), underline: t.depth === 1 && mono() }))));
        return;
      }
      case 'paragraph': case 'text':
        out.push(h(Box, { key: k }, h(WText, null, ...inline(t.tokens || [{ type: 'text', text: t.text }], {}, k))));
        return;
      case 'code': {
        const lines = String(t.text).split('\n');
        out.push(h(Box, { key: k, flexDirection: 'column', width: cols },
          codeRule(cols, t.lang ? String(t.lang).split(/\s+/)[0] : ''),
          ...lines.map((ln, j) => h(Text, { key: j, color: c('text') }, ln || ' ')),
          h(Text, { color: c('codeRule') }, rule(cols))));
        return;
      }
      case 'list': out.push(h(List, { key: k, t, cols, depth })); return;
      case 'blockquote':
        out.push(h(Box, { key: k },
          h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: c('label') }, '▎ ')),
          h(Box, { flexDirection: 'column', flexGrow: 1, flexShrink: 1 }, ...blocks(t.tokens, cols - 2, depth + 1, k))));
        return;
      case 'hr': out.push(h(Text, { key: k, color: c('dim') }, '─'.repeat(cols))); return;
      case 'table': out.push(h(Table, { key: k, t, cols })); return;
      case 'html': out.push(h(Text, { key: k, color: c('dim') }, t.text.trim())); return;
      case 'def': return;
      default: out.push(h(Text, { key: k }, unesc(t.raw || '')));
    }
  });
  return out;
}

/** Render markdown text. live = unfinished tail of a streaming answer. */
export function Markdown({ text, cols, live = false }) {
  const src = live ? healInline(text) : text;
  if (!src.trim()) return null;
  const kids = blocks(lex(src), cols).map((el, i) => h(Box, { key: el.key ?? i, marginTop: i ? 1 : 0, flexDirection: 'column' }, el));
  return h(Box, { flexDirection: 'column', width: cols }, ...kids);
}

// ---- height (sizes the live region; must match what Ink lays out) ---------------------------------
/** Rows one line takes in Ink's Text wrap (wrap-ansi 9, trim: false, hard: true), plain text only. */
function wrapLineRows(line, cols) {
  if (cols <= 0) return 1;
  const words = line.split(' ');
  const rows = [0];
  words.forEach((word, i) => {
    let len = rows[rows.length - 1];
    const wl = w(word);
    if (i !== 0) {
      if (len >= cols) { rows.push(0); len = 0; }
      rows[rows.length - 1] = ++len;
    }
    if (wl > cols) { // hard-break a word longer than the line
      const remaining = cols - len;
      const startHere = 1 + Math.floor((wl - remaining - 1) / cols);
      const startNext = Math.floor((wl - 1) / cols);
      if (startNext < startHere) rows.push(0);
      let vis = rows[rows.length - 1];
      const chars = graphemes(word);
      chars.forEach((_, k) => {
        if (vis + 1 <= cols) rows[rows.length - 1] = ++vis;
        else { rows.push(1); vis = 1; }
        if (vis === cols && k < chars.length - 1) { rows.push(0); vis = 0; }
      });
      if (!vis && rows.length > 1 && rows[rows.length - 1] === 0) rows.pop();
      return;
    }
    if (len + wl > cols && len > 0 && wl > 0) { rows.push(0); len = 0; }
    rows[rows.length - 1] = len + wl;
  });
  return rows.length;
}

/** Rows a plain string takes when Ink wraps it at `cols`. */
export function wrapRows(text, cols) {
  return String(text).replace(/\r\n/g, '\n').split('\n').reduce((n, l) => n + wrapLineRows(l, cols), 0);
}

function inlineStr(tokens = []) {
  return tokens.map(t => {
    switch (t.type) {
      case 'strong': case 'em': case 'del': return inlineStr(t.tokens);
      case 'codespan': return mono() ? '`' + unesc(t.text) + '`' : ' ' + unesc(t.text) + ' ';
      case 'br': return '\n';
      case 'link': { const label = inlineText(t.tokens) || t.href; return label + (label !== t.href ? ` (${t.href})` : ''); }
      case 'image': return `[image: ${t.text || t.href}]`;
      case 'escape': case 'html': return t.text;
      case 'text': return t.tokens ? inlineStr(t.tokens) : unesc(t.text);
      default: return unesc(t.text ?? t.raw ?? '');
    }
  }).join('');
}

/** Heights of the elements blocks() would produce, in order (space/def produce none). */
function blockRows(tokens = [], cols, depth = 0) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space': case 'def': break;
      case 'heading': out.push(wrapRows(inlineStr(t.tokens), cols) + (depth ? 0 : 1)); break;
      case 'paragraph': case 'text': out.push(wrapRows(inlineStr(t.tokens || [{ type: 'text', text: t.text }]), cols)); break;
      case 'code': out.push(2 + String(t.text).split('\n').reduce((n, ln) => n + wrapRows(ln || ' ', cols), 0)); break;
      case 'list': {
        out.push(t.items.reduce((n, it, i) => {
          const marker = t.ordered ? `${(typeof t.start === 'number' ? t.start : 1) + i}.` : '•';
          const inner = blockRows(it.tokens, cols - (w(marker) + 1), depth + 1).reduce((a, b) => a + b, 0);
          return n + Math.max(1, inner);
        }, 0));
        break;
      }
      case 'blockquote': out.push(Math.max(1, blockRows(t.tokens, cols - 2, depth + 1).reduce((a, b) => a + b, 0))); break;
      case 'hr': out.push(1); break;
      case 'table': out.push(layoutTable(t.header.map(x => inlineText(x.tokens)), t.rows.map(r => r.map(x => inlineText(x.tokens))), cols).lines.length); break;
      case 'html': out.push(wrapRows(t.text.trim(), cols)); break;
      default: out.push(wrapRows(unesc(t.raw || ''), cols));
    }
  }
  return out;
}

/** Rows <Markdown text cols live/> occupies. Pure; mirrors Markdown() above. */
export function markdownRows(text, cols, live = false) {
  const src = live ? healInline(text) : text;
  if (!src.trim()) return 0;
  const rows = blockRows(lex(src), cols);
  return rows.reduce((a, b) => a + b, 0) + Math.max(0, rows.length - 1);
}
