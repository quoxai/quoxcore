/**
 * PEEK card: the hit of `/peek <id>` as an inline object (the box layout keeps the label column; a note would
 * re-flow it). Fields come from core/peek.js ROWS, the same list `quox peek` prints. d: a peekId result.
 */
import { seg, fit, boxWidth } from './model.js';
import { KIND_LABEL, ROWS, MORE } from '../../core/peek.js';

export function peekCard(d, cols) {
  const w = boxWidth(cols, 84), inner = w - 4;
  const { kind, data } = d.hit || {};
  const rows = [];
  const L = (label, value, role = 'value') => [seg(label.padEnd(10), 'muted'), seg(fit(value, inner - 10), role)];
  for (const [k, v] of (ROWS[kind] ? ROWS[kind](data || {}) : [])) if (v) rows.push(L(k, v));
  if (d.also?.length) rows.push(L('also', `an id of the same value: ${d.also.map(k => KIND_LABEL[k]).join(', ')}`, 'muted'));
  if (MORE[kind]) rows.push(L('more', MORE[kind](d.id), 'muted'));
  return { box: { width: w, title: `◇ ${KIND_LABEL[kind] || 'id'} ${d.id}`, titleRole: 'sky', right: 'read only', rightRole: 'muted', border: 'sky' }, rows };
}
