/**
 * E5 "While you were away": a factual digest since a moment, from GET /api/v1/away (collector). Every
 * item carries the source that reported it and its time; nothing is summarised by a model. Sources the
 * server could not read, or that went silent, come back in `blind` and are always named ("Can't see"),
 * so an empty list never reads as an all clear it cannot vouch for.
 */
import { seg, fit, hhmm, plural, boxWidth, parseTs } from './model.js';

/** Importance: approvals waiting first (they block work), then alerts, failures, then outcomes. */
export const RANK = {
  approval_waiting: 0, alert: 1, turn_failed: 2, objective_failed: 2, workflow_failed: 2,
  approval_resolved: 3, objective_finished: 4, workflow_finished: 4, decision: 5
};
const GLYPH = {
  approval_waiting: ['⚠ ', 'warn'], alert: ['⚠ ', 'warn'], turn_failed: ['✖ ', 'error'], objective_failed: ['✖ ', 'error'],
  workflow_failed: ['✖ ', 'error'], approval_resolved: ['✔ ', 'ok'], objective_finished: ['✔ ', 'ok'],
  workflow_finished: ['✔ ', 'ok'], decision: ['◆ ', 'indigo']
};
const rankOf = (it) => RANK[it?.kind] ?? 6;

export function rankItems(items) {
  return [...(items || [])].sort((a, b) => rankOf(a) - rankOf(b) || (parseTs(b.ts) ?? 0) - (parseTs(a.ts) ?? 0));
}

/** "5h", "45m", "2d" for the away window. */
export function awayFor(sinceTs, now) {
  const t = parseTs(sinceTs);
  if (t == null) return '';
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** d: { since, items, blind, activity, compact?, max?, now } */
export function awayCard(d, cols) {
  const now = d.now ?? Date.now();
  const w = boxWidth(cols, 96), inner = w - 4;
  const items = rankItems(d.items);
  const max = d.compact ? (d.max ?? 5) : items.length;
  const shown = items.slice(0, max);
  const rows = [];
  const win = awayFor(d.since, now);
  if (!items.length) rows.push([seg(d.standing && d.standing.count > 0 ? 'Nothing new needed you.' : 'Nothing needed you.', 'muted')]);
  for (const it of shown) {
    const [g, role] = GLYPH[it.kind] || ['· ', 'muted'];
    const meta = `${it.source || '?'} · ${hhmm(it.ts) || 'time unknown'}`;
    if (d.compact) {
      rows.push([seg(g, role), seg(fit(it.title, Math.max(8, inner - 2 - meta.length - 2)), 'value'), seg(`  ${meta}`, 'muted')]);
    } else {
      rows.push([seg(g, role), seg(fit(it.title, inner - 2), 'value', rankOf(it) === 0)]);
      rows.push([seg('  '), seg(fit(meta, inner - 2), 'muted')]);
    }
  }
  if (items.length > shown.length) rows.push([seg(`+${items.length - shown.length} more · /away`, 'muted')]);
  if (d.standing && d.standing.count > 0) rows.push([seg(fit(`${plural(d.standing.count, 'older item')} still need${d.standing.count === 1 ? 's' : ''} you · quox lucid`, inner), 'muted')]);
  const act = d.activity;
  if (act && act.total > 0 && !d.compact) {
    const top = (act.agents || []).slice(0, 4).map(a => `${a.agent} ${a.count}`).join(', ');
    rows.push([seg(' ')]);
    rows.push([seg(fit(`${act.partial ? 'at least ' : ''}${plural(act.total, 'agent action')}${top ? `: ${top}` : ''}${act.source ? ` (${act.source})` : ''}`, inner), 'muted')]);
  }
  const blind = d.blind || [];
  if (blind.length && d.compact) {
    const what = blind.map(b => (b.reason ? `${b.source} (${b.reason})` : b.source)).join(', ');
    rows.push([seg(fit(`Can't see: ${what}`, inner), 'faint')]);
  } else if (blind.length) {
    rows.push([seg("Can't see:", 'faint')]);
    for (const b of blind) rows.push([seg('  '), seg(fit(`${b.source}${b.reason ? `: ${b.reason}` : ''}`, inner - 2), 'faint')]);
  }
  return { box: { width: w, title: `While you were away${win ? ` (${win})` : ''}`, titleRole: 'value', right: d.compact ? '' : `since ${hhmm(d.since)}`, rightRole: 'muted', border: items.some(i => rankOf(i) === 0) ? 'warn' : 'muted' }, rows };
}
