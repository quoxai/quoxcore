/**
 * LUCID object cards: pure views for the deck, in the Quoxon object-card shape ({ box, rows } of
 * { text, role } segments, see quoxon/objects/model.js). An area is a tile card; a Needs-you item is a card
 * that opens in place into who / what / why / when and the actions. Nothing here reads a clock or does I/O.
 *
 * Roles are theme roles; the renderer (LucidCard.jsx) also understands 'sel' (the selected action bar).
 * Text is WRAPPED to the card, never clipped, except for a single action line and the command line.
 */
import { seg, fit, padRow } from '../quoxon/objects/model.js';
import { wrap, whenText, ageOf, GLYPH, clip } from './fmt.js';

export const URGENCY_ROLE = { now: 'error', today: 'warn', 'this week': 'sky', whenever: 'muted', fyi: 'muted' };
export const URGENCY_LABEL = { now: 'NOW', today: 'TODAY', 'this week': 'THIS WEEK', whenever: 'WHENEVER', fyi: 'FYI' };
export const STATE_ROLE = { ok: 'ok', attention: 'warn', unknown: 'muted', blind: 'error' };
export const STATE_WORD = { ok: 'ok', attention: 'attention', unknown: 'no signal', blind: 'blind' };

const nm = (x) => (typeof x === 'string' ? x : (x && (x.label || x.name || x.L0 || x.id)) || '');
const LW = 8; // label column of the open card

/**
 * An area tile. d: { area, label, state, L0, last, n (needs), active (filter on), selected, focused,
 * expanded, now }. A tile is one status row; the selected tile in a focused pane opens to its sentence.
 */
export function lucidArea(d, cols) {
  const w = Math.max(18, cols), inner = w - 4;
  const all = d.area == null;
  const glyph = all ? '◉' : (GLYPH[d.state] || '?');
  const role = all ? 'sky' : (STATE_ROLE[d.state] || 'muted');
  const right = `${d.active ? '● ' : ''}${d.n ? d.n : '·'}`;
  const rows = [];
  const word = all ? 'everything' : (STATE_WORD[d.state] || 'unknown');
  const age = d.last && d.last.ts != null && d.now != null ? `last ${ageOf(d.last.ts, d.now)}` : '';
  const line = age && [...`${word} · ${age}`].length <= inner ? `${word} · ${age}` : word;
  rows.push([seg(line, d.selected ? 'value' : role === 'ok' ? 'muted' : role)]);
  if (d.expanded && d.L0) for (const ln of wrap(d.L0, inner)) rows.push([seg(ln, 'value')]);
  const mark = d.selected ? '▶ ' : '';
  return {
    box: {
      width: w, title: `${mark}${glyph} ${fit(d.label || d.area || 'All areas', Math.max(4, inner - 8))}`, titleRole: role,
      right, rightRole: d.n ? 'warn' : 'muted', border: d.selected ? 'sky' : 'faint', sel: d.selected ? (d.focused ? 'focus' : 'dim') : null,
    },
    rows,
  };
}

/**
 * A Needs-you card. d: { item, areaLabel, isNew, selected, focused, open, mSel, now }.
 * Collapsed: the wrapped sentence. Open: the sentence, who/what/why/when, affects, then the actions with
 * the highlighted one as a bar and its exact command beneath.
 */
export function lucidNeed(d, cols) {
  const it = d.item, w = Math.max(24, cols), inner = w - 4;
  const urg = it.urgency || 'whenever';
  const a = it.L1 || {};
  const ms = (it.L2 && it.L2.measures) || [];
  const mark = d.selected ? '▶ ' : '';
  const rows = [];
  const text = (d.isNew ? '● ' : '') + (it.L0 || '');
  wrap(text, inner).forEach((ln, i) => rows.push([seg(ln, d.isNew ? 'ok' : d.selected ? 'value' : 'text', d.selected)]));
  if (d.open) {
    const detail = (lbl, v) => wrap(v, inner - LW).forEach((ln, i) => rows.push([seg(i ? ' '.repeat(LW) : lbl.padEnd(LW), i ? 'muted' : 'label'), seg(ln, 'text')]));
    for (const [lbl, v] of [['Who', a.who], ['What', a.what], ['Why', a.why], ['When', whenText(a.when, d.now)]]) if (v) detail(lbl, v);
    if ((a.affected || []).length) rows.push([seg('Affects'.padEnd(LW), 'label'), seg(clip(a.affected.map(nm).filter(Boolean).join(', '), inner - LW), 'muted')]);
    rows.push(ms.length ? [seg('What you can do', 'key', true)] : [seg('No actions to offer here. Esc closes.', 'muted')]);
    ms.forEach((m, mi) => {
      const on = mi === d.mSel;
      const risk = ` ${m.risk}`;
      const label = fit(m.say || m.label, Math.max(8, inner - 2 - risk.length));
      if (on) rows.push([seg(`❯ ${label}${risk}`.padEnd(inner, ' '), 'sel', true)]);
      else rows.push([seg('  ', 'muted'), seg(label, 'text'), seg(risk, m.risk === 'dangerous' ? 'error' : m.risk === 'gated' ? 'warn' : 'muted')]);
    });
    const cmd = ms[d.mSel] && ms[d.mSel].command;
    if (cmd) rows.push([seg('  $ ', 'muted'), seg(clip(cmd, inner - 4), 'code')]);
    else if (ms.some((m) => m.command)) rows.push([seg(' ', 'muted')]);
  }
  return {
    box: {
      width: w, title: `${mark}${URGENCY_LABEL[urg] || String(urg).toUpperCase()} · ${it.kind || 'item'}`, titleRole: URGENCY_ROLE[urg] || 'muted',
      right: d.areaLabel || '', rightRole: 'muted', border: d.selected ? 'sky' : (urg === 'now' ? 'error' : 'faint'), sel: d.selected ? (d.focused ? 'focus' : 'dim') : null,
    },
    rows,
  };
}

export const cardHeight = (view) => view.rows.length + 2;
export { padRow };
