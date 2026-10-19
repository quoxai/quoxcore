/**
 * <ObjectView/>: the one Ink component for the inline object views. It maps a pure view (rows of
 * { text, role } segments, optional box) to <Text> runs. `t` is seconds since arrival for the lab's
 * decode-in (rows start 0.1 s apart); the default Infinity is the settled card, which is what history
 * shows while there is no shared motion clock on main. Quiet (NO_COLOR or reduced motion) is always
 * settled; NO_COLOR also drops every colour (c() returns undefined).
 */
import React from 'react';
import { Box, Text } from 'ink';
import { c, agentColor, mono } from '../theme.js';
import { reducedMotion } from '../motion/clock.js';
import { buildObject } from './index.js';
import { decodeRow, padRow, fit, len } from './model.js';

const h = React.createElement;

/** Role -> Ink colour. agent:<name> uses the stable agent shade. */
export function roleColor(role) {
  if (mono()) return undefined;
  if (typeof role === 'string' && role.startsWith('agent:')) return agentColor(role.slice(6));
  return c(role || 'value');
}

function runsOf(cells, key) {
  const out = [];
  let run = '', role, bold = false, glyph = false, k = 0;
  const flush = () => { if (run) out.push(h(Text, { key: `${key}-${k++}`, color: glyph ? roleColor('faint') : roleColor(role), bold }, run)); run = ''; };
  for (const cl of cells) {
    if (cl.role !== role || cl.bold !== bold || cl.glyph !== glyph) { flush(); role = cl.role; bold = cl.bold; glyph = cl.glyph; }
    run += cl.ch;
  }
  flush();
  return out;
}

/** Rows start this far apart (at most 0.1 s, the lab) so the last one lands inside the 0.65 s reveal window. */
export const STAGGER_SPAN = 0.3;
export const rowStart = (i, n) => i * Math.min(0.1, STAGGER_SPAN / Math.max(1, n - 1));
const rowNode = (row, i, n, t, key) => h(Text, { key, wrap: 'truncate' }, ...runsOf(decodeRow(row, t, rowStart(i, n), 0.25, 70 + i), key));

export function ObjectView({ item, cols, fx = null, t = fx && fx.e != null ? fx.e : Infinity, now }) {
  const view = buildObject(item.obj || item, cols, now);
  const tt = reducedMotion() ? Infinity : t;
  const rows = view.rows || [];
  if (!view.box) {
    return h(Box, { flexDirection: 'column', marginTop: 1, paddingLeft: 2 }, ...rows.map((r, i) => rowNode(r, i, rows.length, tt, `r${i}`)));
  }
  const b = view.box, w = b.width, inner = w - 4;
  const bc = roleColor(b.border || 'muted');
  const right = b.right ? ` ${b.right} ` : '';
  const title = b.title ? ` ${fit(b.title, Math.max(4, w - 6 - (right ? len(right) + 1 : 0)))} ` : '';
  const fill = Math.max(0, w - 3 - len(title) - len(right) - 1);
  const top = h(Text, { key: 'top', wrap: 'truncate' },
    h(Text, { color: bc }, '╭─'),
    h(Text, { color: roleColor(b.titleRole || 'value'), bold: true }, title),
    h(Text, { color: bc }, '─'.repeat(fill)),
    h(Text, { color: roleColor(b.rightRole || 'muted') }, right),
    h(Text, { color: bc }, '─╮'));
  const body = rows.map((r, i) => h(Text, { key: `b${i}`, wrap: 'truncate' },
    h(Text, { color: bc }, '│ '), ...runsOf(decodeRow(padRow(r, inner), tt, rowStart(i, rows.length), 0.25, 70 + i), `b${i}`), h(Text, { color: bc }, ' │')));
  const bottom = h(Text, { key: 'bot', color: bc }, '╰' + '─'.repeat(w - 2) + '╯');
  return h(Box, { flexDirection: 'column', marginTop: 1, paddingLeft: 1 }, top, ...body, bottom);
}

/**
 * TUI-UX #5: would this card (rows + border + margin) be taller than the terminal? Ink cannot erase rows that already scrolled
 * off the top of a live region, so a decode-in on such a card leaves a half-decoded copy in scrollback. Callers skip the
 * animation for it and commit it settled.
 */
export function cardTallerThanScreen(item, cols, termRows, now) {
  if (!Number.isFinite(termRows) || termRows <= 0) return false;
  const view = buildObject(item.obj || item, cols, now);
  return (view.rows || []).length + (view.box ? 3 : 1) + 2 >= termRows; // top + bottom border, marginTop, plus the composer line
}

/** Plain text of a view at a width (tests, transcripts, --print): the box drawn with the same geometry. */
export function objectText(item, cols, now) {
  const view = buildObject(item.obj || item, cols, now);
  const rt = (r) => r.map(s => s.text).join('');
  if (!view.box) return view.rows.map(r => '  ' + rt(fitRowText(r, cols - 2))).join('\n');
  const b = view.box, w = b.width, inner = w - 4;
  const right = b.right ? ` ${b.right} ` : '';
  const title = b.title ? ` ${fit(b.title, Math.max(4, w - 6 - (right ? len(right) + 1 : 0)))} ` : '';
  const fill = Math.max(0, w - 3 - len(title) - len(right) - 1);
  return [` ╭─${title}${'─'.repeat(fill)}${right}─╮`, ...view.rows.map(r => ` │ ${rt(padRow(r, inner))} │`), ` ╰${'─'.repeat(w - 2)}╯`].join('\n');
}
const fitRowText = (r, n) => padRow(r, n).filter((s, i, a) => !(i === a.length - 1 && /^ +$/.test(s.text)));
