/**
 * <LucidCard/>: draws a Quoxon object-card view ({ box, rows }, see cards.js) for the deck.
 *
 * Same geometry and roles as quoxon/objects/view.js, plus what a navigable list needs:
 *   box.sel 'focus' | 'dim'   the title sits on a bar (and inverse under NO_COLOR) so the selected card is unmistakable
 *   role 'sel'                the highlighted action bar
 *   t (seconds)               drop-in reveal: rows decode through half-width katakana, then a short colour
 *                             afterglow on the real characters. Infinity = settled (what idle always shows).
 * Colour comes from the theme roles (light/dark, 256-colour, NO_COLOR); the characters never change.
 */
import React from 'react';
import { Text } from 'ink';
import { c, mono } from '../quoxon/theme.js';
import { agentColor } from '../quoxon/theme.js';
import { decodeRow, padRow, fit, len } from '../quoxon/objects/model.js';
import { rowStart } from '../quoxon/objects/view.js';
import { hexRgb, mix, rgbStr } from '../quoxon/motion/color.js';

const h = React.createElement;
export const BAR = { focus: '#1E3A8A', dim: '#27272A' }; // selection bars (white text on both)

function roleColor(role) {
  if (mono()) return undefined;
  if (typeof role === 'string' && role.startsWith('agent:')) return agentColor(role.slice(6));
  return c(role || 'value');
}
/** A role colour lifted towards white by the afterglow (hex colours only; anything else stays as is). */
function glowColor(role, g) {
  const base = roleColor(role);
  return typeof base === 'string' && base[0] === '#' ? rgbStr(mix(hexRgb(base), [255, 255, 255], 0.65 * g)) : base;
}

function runs(cells, key) {
  const out = [];
  let run = '', col, bold = false, bg, k = 0;
  const flush = () => { if (run) out.push(h(Text, { key: `${key}-${k++}`, color: col, bold, backgroundColor: bg }, run)); run = ''; };
  for (const cl of cells) {
    let color, back;
    if (cl.role === 'sel') { color = mono() ? undefined : '#FFFFFF'; back = mono() ? undefined : BAR.focus; }
    else if (cl.glyph) color = roleColor('teal'); // the katakana flicker
    else color = cl.glow > 0.05 ? glowColor(cl.role, cl.glow) : roleColor(cl.role);
    const b = Boolean(cl.bold);
    if (color !== col || b !== bold || back !== bg) { flush(); col = color; bold = b; bg = back; }
    run += cl.ch;
  }
  flush();
  return out;
}

export function LucidCard({ view, t = Infinity }) {
  const b = view.box, w = b.width, inner = w - 4;
  const rows = view.rows || [];
  const bc = roleColor(b.border || 'faint');
  const right = b.right ? ` ${b.right} ` : '';
  const title = b.title ? ` ${fit(b.title, Math.max(4, w - 6 - (right ? len(right) + 1 : 0)))} ` : '';
  const fill = Math.max(0, w - 3 - len(title) - len(right) - 1);
  const bar = b.sel ? BAR[b.sel] : null;
  const top = h(Text, { key: 'top', wrap: 'truncate' },
    h(Text, { color: bc }, '╭─'),
    h(Text, { color: bar && !mono() ? '#FFFFFF' : roleColor(b.titleRole || 'value'), backgroundColor: bar && !mono() ? bar : undefined, inverse: Boolean(bar) && mono(), bold: true }, title),
    h(Text, { color: bc }, '─'.repeat(fill)),
    h(Text, { color: roleColor(b.rightRole || 'muted') }, right),
    h(Text, { color: bc }, '─╮'));
  const body = rows.map((r, i) => h(Text, { key: `b${i}`, wrap: 'truncate' },
    h(Text, { color: bc }, '│ '), ...runs(decodeRow(padRow(r, inner), t, rowStart(i, rows.length), 0.25, 70 + i), `b${i}`), h(Text, { color: bc }, ' │')));
  const bottom = h(Text, { key: 'bot', color: bc }, '╰' + '─'.repeat(w - 2) + '╯');
  return h(React.Fragment, null, top, ...body, bottom);
}
